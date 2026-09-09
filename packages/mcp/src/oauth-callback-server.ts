import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqualString } from './oauth-auth-code-provider.ts';
import { parseLoopbackRedirectUri } from './custom-mcp-config.ts';

export const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const NO_STORE_HEADERS = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
};

const SUCCESS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorization complete</title></head>
<body><p>Authorization complete. You can close this window.</p></body></html>`;

const FAILURE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorization failed</title></head>
<body><p>Authorization failed.</p></body></html>`;

export class OAuthCallbackError extends Error {
    readonly sanitizedMessage: string;

    constructor(sanitizedMessage: string) {
        super(sanitizedMessage);
        this.name = 'OAuthCallbackError';
        this.sanitizedMessage = sanitizedMessage;
    }
}

export interface ValidatedCallback {
    code: string;
    iss?: string;
}

export interface CallbackListener {
    redirectUrl: URL;
    ready(): Promise<void>;
    wait(): Promise<ValidatedCallback>;
    acceptPastedCallbackUrl(raw: string): void;
    close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, NO_STORE_HEADERS);
    res.end(body);
}

function discoveredIssuer(discoveryIssuer: string | undefined): string | undefined {
    return discoveryIssuer;
}

export function issuerFromDiscovery(discovery: { authorizationServerMetadata?: { issuer?: string }; authorizationServerUrl?: string } | undefined): string | undefined {
    return discovery?.authorizationServerMetadata?.issuer
        ?? discovery?.authorizationServerUrl;
}

export function issuerRequiredFromDiscovery(discovery: { authorizationServerMetadata?: { authorization_response_iss_parameter_supported?: boolean } } | undefined): boolean {
    return discovery?.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true;
}

export function validateCallbackSearchParams(opts: {
    params: URLSearchParams;
    expectedState: string;
    expectedIssuer?: string;
    issuerRequired: boolean;
}): ValidatedCallback {
    const state = opts.params.get('state');
    if (!state) {
        throw new OAuthCallbackError('Missing state');
    }
    if (!timingSafeEqualString(state, opts.expectedState)) {
        throw new OAuthCallbackError('Invalid state');
    }

    const iss = opts.params.get('iss') ?? undefined;
    if (opts.issuerRequired && !iss) {
        throw new OAuthCallbackError('Missing issuer');
    }
    if (iss && opts.expectedIssuer && iss !== opts.expectedIssuer) {
        throw new OAuthCallbackError('Issuer mismatch');
    }

    const error = opts.params.get('error');
    if (error) {
        throw new OAuthCallbackError('Authorization denied');
    }

    const code = opts.params.get('code');
    if (!code) {
        throw new OAuthCallbackError('Missing authorization code');
    }
    return { code, iss };
}

export function parsePastedCallbackUrl(raw: string, expectedRedirect: URL): URLSearchParams {
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new OAuthCallbackError('Callback URL is required');
    }
    if (!/^https?:\/\//i.test(trimmed) && !trimmed.includes('://')) {
        throw new OAuthCallbackError('Complete callback URL required');
    }
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new OAuthCallbackError('Invalid callback URL');
    }
    if (parsed.protocol !== expectedRedirect.protocol
        || parsed.hostname !== expectedRedirect.hostname
        || parsed.port !== expectedRedirect.port
        || parsed.pathname !== expectedRedirect.pathname) {
        throw new OAuthCallbackError('Callback URL does not match redirect URI');
    }
    return parsed.searchParams;
}

export function startLoopbackCallback(opts: {
    redirectUri: string;
    expectedState: string;
    expectedIssuer?: string;
    issuerRequired?: boolean;
    timeoutMs?: number;
}): CallbackListener {
    const redirectUrl = parseLoopbackRedirectUri(opts.redirectUri);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;

    let settled = false;
    let consumed = false;
    let server: Server | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let resolveWait: (value: ValidatedCallback) => void;
    let rejectWait: (err: Error) => void;

    const waitPromise = new Promise<ValidatedCallback>((resolve, reject) => {
        resolveWait = resolve;
        rejectWait = reject;
    });
    void waitPromise.catch(() => undefined);

    const finishOk = (value: ValidatedCallback) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolveWait(value);
    };

    const finishErr = (err: Error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        rejectWait(err);
    };

    const handleValidated = (params: URLSearchParams, res?: ServerResponse) => {
        if (consumed) {
            if (res) send(res, 409, FAILURE_PAGE);
            throw new OAuthCallbackError('Authorization callback already used');
        }
        consumed = true;
        try {
            const result = validateCallbackSearchParams({
                params,
                expectedState: opts.expectedState,
                expectedIssuer: discoveredIssuer(opts.expectedIssuer),
                issuerRequired: opts.issuerRequired === true,
            });
            if (res) send(res, 200, SUCCESS_PAGE);
            finishOk(result);
            return result;
        } catch (err) {
            if (res) send(res, 400, FAILURE_PAGE);
            const wrapped = err instanceof OAuthCallbackError ? err : new OAuthCallbackError('Authorization failed');
            finishErr(wrapped);
            throw wrapped;
        }
    };

    const onRequest = (req: IncomingMessage, res: ServerResponse) => {
        try {
            if (req.method !== 'GET') {
                send(res, 405, FAILURE_PAGE);
                return;
            }
            const host = req.headers.host ?? `127.0.0.1:${redirectUrl.port || '80'}`;
            const url = new URL(req.url ?? '/', `http://${host}`);
            if (url.pathname !== redirectUrl.pathname) {
                send(res, 404, FAILURE_PAGE);
                return;
            }
            if (consumed || settled) {
                send(res, 409, FAILURE_PAGE);
                return;
            }
            try {
                handleValidated(url.searchParams, res);
            } catch {
                // already recorded
            }
        } catch {
            send(res, 500, FAILURE_PAGE);
        }
    };

    server = createServer(onRequest);

    const listenPromise = new Promise<void>((resolve, reject) => {
        server!.once('error', (err) => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }
            finishErr(err instanceof Error ? err : new Error('listen failed'));
            reject(err);
        });
        server!.listen(Number(redirectUrl.port || 80), '127.0.0.1', () => {
            server!.removeAllListeners('error');
            resolve();
        });
    });
    void listenPromise.catch(() => undefined);

    timeout = setTimeout(() => {
        finishErr(new OAuthCallbackError('Authorization timed out'));
        void closeServer();
    }, timeoutMs);

    const closeServer = async () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
        }
        const current = server;
        server = undefined;
        if (!current) return;
        await new Promise<void>((resolve) => {
            current.close(() => resolve());
        });
    };

    return {
        redirectUrl,
        ready() {
            return listenPromise;
        },
        async wait() {
            await listenPromise;
            try {
                return await waitPromise;
            } finally {
                await closeServer();
            }
        },
        acceptPastedCallbackUrl(raw: string) {
            const params = parsePastedCallbackUrl(raw, redirectUrl);
            handleValidated(params);
        },
        async close() {
            if (!settled) {
                finishErr(new OAuthCallbackError('Authorization cancelled'));
            }
            await closeServer();
        },
    };
}

export function stripSensitiveUrl(url: URL): string {
    const copy = new URL(url.toString());
    copy.search = '';
    copy.hash = '';
    return copy.toString();
}

export function authorizationUrlForDisplay(url: URL): string {
    return url.toString();
}
