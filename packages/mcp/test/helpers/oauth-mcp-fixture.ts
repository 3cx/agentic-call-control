import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

export interface FixtureOptions {
    clientId: string;
    clientSecret: string;
    accessToken?: string;
    refreshToken?: string;
    issuerRequired?: boolean;
    rejectBearer?: (token: string, n: number) => boolean;
}

export interface OAuthMcpFixture {
    baseUrl: string;
    mcpUrl: string;
    issuer: string;
    port: number;
    tokenRequests: Array<{ grant?: string; authorization?: string }>;
    mcpMethods: string[];
    issuedCodes: string[];
    close(): Promise<void>;
    issueAuthorizationCode(): string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function basicCreds(header: string | undefined): { id: string; secret: string } | undefined {
    if (!header?.startsWith('Basic ')) return undefined;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return undefined;
    return { id: decoded.slice(0, idx), secret: decoded.slice(idx + 1) };
}

export async function startOAuthMcpFixture(opts: FixtureOptions): Promise<OAuthMcpFixture> {
    const accessToken = opts.accessToken ?? 'access-token';
    const refreshToken = opts.refreshToken ?? 'refresh-token';
    const issuedCodes: string[] = [];
    const tokenRequests: Array<{ grant?: string; authorization?: string }> = [];
    const mcpMethods: string[] = [];
    let bearerHits = 0;

    let baseUrl = '';
    let issuer = '';

    const httpServer: Server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', baseUrl || 'http://127.0.0.1');
        const path = url.pathname;

        if (path === '/.well-known/oauth-protected-resource' || path.startsWith('/.well-known/oauth-protected-resource')) {
            sendJson(res, 200, {
                resource: `${baseUrl}/mcp`,
                authorization_servers: [issuer],
                bearer_methods_supported: ['header'],
            });
            return;
        }

        if (path === '/.well-known/oauth-authorization-server') {
            sendJson(res, 200, {
                issuer,
                authorization_endpoint: `${issuer}/authorize`,
                token_endpoint: `${issuer}/token`,
                response_types_supported: ['code'],
                grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
                code_challenge_methods_supported: ['S256'],
                token_endpoint_auth_methods_supported: ['client_secret_basic'],
                authorization_response_iss_parameter_supported: opts.issuerRequired === true,
            });
            return;
        }

        if (path === '/token' && req.method === 'POST') {
            const body = await readBody(req);
            const params = new URLSearchParams(body);
            tokenRequests.push({
                grant: params.get('grant_type') ?? undefined,
                authorization: req.headers.authorization,
            });
            const creds = basicCreds(req.headers.authorization);
            if (!creds || creds.id !== opts.clientId || creds.secret !== opts.clientSecret) {
                sendJson(res, 401, { error: 'invalid_client' });
                return;
            }
            const grant = params.get('grant_type');
            if (grant === 'client_credentials') {
                sendJson(res, 200, {
                    access_token: accessToken,
                    token_type: 'Bearer',
                    expires_in: 3600,
                    scope: params.get('scope') ?? 'mcp:tools',
                });
                return;
            }
            if (grant === 'authorization_code') {
                const code = params.get('code');
                if (!code || !issuedCodes.includes(code)) {
                    sendJson(res, 400, { error: 'invalid_grant' });
                    return;
                }
                sendJson(res, 200, {
                    access_token: accessToken,
                    token_type: 'Bearer',
                    expires_in: 3600,
                    refresh_token: refreshToken,
                    scope: 'mcp:tools',
                });
                return;
            }
            if (grant === 'refresh_token') {
                if (params.get('refresh_token') !== refreshToken) {
                    sendJson(res, 400, { error: 'invalid_grant' });
                    return;
                }
                sendJson(res, 200, {
                    access_token: `${accessToken}-refreshed`,
                    token_type: 'Bearer',
                    expires_in: 3600,
                    refresh_token: refreshToken,
                });
                return;
            }
            sendJson(res, 400, { error: 'unsupported_grant_type' });
            return;
        }

        if (path === '/mcp') {
            const authz = req.headers.authorization ?? '';
            const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
            bearerHits += 1;
            const rejectBearer = req.method === 'POST' && (opts.rejectBearer?.(token, bearerHits) ?? false);
            if (!token || rejectBearer || (token !== accessToken && token !== `${accessToken}-refreshed`)) {
                res.writeHead(401, {
                    'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
                });
                res.end();
                return;
            }

            if (req.method === 'GET') {
                res.writeHead(405);
                res.end();
                return;
            }
            if (req.method !== 'POST') {
                res.writeHead(405);
                res.end();
                return;
            }
            const raw = await readBody(req);
            const message = raw ? JSON.parse(raw) as { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string } } : {};
            if (message.method) mcpMethods.push(message.method);
            if (message.method === 'initialize') {
                sendJson(res, 200, {
                    jsonrpc: '2.0',
                    id: message.id ?? 1,
                    result: {
                        protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'fixture', version: '1.0.0' },
                    },
                });
                return;
            }
            if (message.method === 'notifications/initialized') {
                res.writeHead(202);
                res.end();
                return;
            }
            if (message.method === 'tools/list') {
                sendJson(res, 200, {
                    jsonrpc: '2.0',
                    id: message.id ?? 1,
                    result: {
                        tools: [{
                            name: 'whoami',
                            description: 'identity',
                            inputSchema: { type: 'object', properties: {} },
                        }],
                    },
                });
                return;
            }
            if (message.method === 'tools/call') {
                sendJson(res, 200, {
                    jsonrpc: '2.0',
                    id: message.id ?? 1,
                    result: { content: [{ type: 'text', text: 'fixture-user' }] },
                });
                return;
            }
            sendJson(res, 200, {
                jsonrpc: '2.0',
                id: message.id ?? null,
                error: { code: -32601, message: 'Method not found' },
            });
            return;
        }

        res.writeHead(404);
        res.end();
    });

    await new Promise<void>((resolve, reject) => {
        httpServer.listen(0, '127.0.0.1', () => resolve());
        httpServer.once('error', reject);
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to bind fixture');
    const port = addr.port;
    baseUrl = `http://127.0.0.1:${port}`;
    issuer = baseUrl;

    return {
        baseUrl,
        mcpUrl: `${baseUrl}/mcp`,
        issuer,
        port,
        tokenRequests,
        mcpMethods,
        issuedCodes,
        issueAuthorizationCode() {
            const code = `code-${randomUUID()}`;
            issuedCodes.push(code);
            return code;
        },
        async close() {
            await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        },
    };
}
