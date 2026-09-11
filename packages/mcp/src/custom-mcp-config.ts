import { dirname, isAbsolute, resolve } from 'node:path';
import {
    CustomMcpConfigError,
    DEFAULT_REDIRECT_URI,
    type CustomMcpAuth,
    type CustomMcpServerConfig,
} from './custom-mcp-auth.ts';

export type NormalizedCustomMcpAuth =
    | { type: 'none' }
    | { type: 'bearer'; token: string }
    | {
        type: 'oauth';
        grant: 'client_credentials';
        clientId: string;
        clientSecret: string;
        scope?: string;
    }
    | {
        type: 'oauth';
        grant: 'authorization_code';
        clientId: string;
        clientSecret?: string;
        redirectUri: string;
        tokenStore: string;
        scope?: string;
    };

export interface NormalizedCustomMcpServer {
    name: string;
    url: string;
    auth: NormalizedCustomMcpAuth;
}

export function parseLoopbackRedirectUri(value: string, serverName = ''): URL {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new CustomMcpConfigError(serverName, 'auth.redirectUri', 'malformed URL');
    }

    if (parsed.protocol !== 'http:') {
        throw new CustomMcpConfigError(serverName, 'auth.redirectUri', 'only http://127.0.0.1 is allowed');
    }
    if (parsed.hostname !== '127.0.0.1') {
        throw new CustomMcpConfigError(serverName, 'auth.redirectUri', 'must use host 127.0.0.1 (loopback only)');
    }
    if (parsed.username || parsed.password) {
        throw new CustomMcpConfigError(serverName, 'auth.redirectUri', 'must not contain credentials');
    }
    if (parsed.hash) {
        throw new CustomMcpConfigError(serverName, 'auth.redirectUri', 'must not contain a fragment');
    }
    if (parsed.search) {
        throw new CustomMcpConfigError(serverName, 'auth.redirectUri', 'must not contain query parameters');
    }
    if (!parsed.pathname || parsed.pathname === '/') {
        throw new CustomMcpConfigError(serverName, 'auth.redirectUri', 'must include a callback path');
    }
    return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return undefined;
}

function optionalString(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function rejectUnexpectedFields(
    serverName: string,
    record: Record<string, unknown>,
    allowed: readonly string[],
    prefix: string,
): void {
    const allowedSet = new Set(allowed);
    for (const field of Object.keys(record)) {
        if (!allowedSet.has(field)) {
            throw new CustomMcpConfigError(serverName, `${prefix}${field}`, 'not allowed');
        }
    }
}

export function normalizeCustomMcpAuth(
    serverName: string,
    raw: unknown,
    configPath: string,
): NormalizedCustomMcpAuth {
    if (raw === undefined || raw === null) {
        return { type: 'none' };
    }
    const auth = asRecord(raw);
    if (!auth) {
        throw new CustomMcpConfigError(serverName, 'auth', 'must be an object');
    }

    const type = optionalString(auth.type) ?? 'none';

    if (type === 'none') {
        rejectUnexpectedFields(serverName, auth, ['type'], 'auth.');
        return { type: 'none' };
    }

    if (type === 'bearer') {
        rejectUnexpectedFields(serverName, auth, ['type', 'token'], 'auth.');
        if (typeof auth.token !== 'string' || auth.token.length === 0) {
            throw new CustomMcpConfigError(serverName, 'auth.token', 'required for bearer auth');
        }
        return { type: 'bearer', token: auth.token };
    }

    if (type !== 'oauth') {
        throw new CustomMcpConfigError(serverName, 'auth.type', `unsupported value "${type}"`);
    }

    const grant = optionalString(auth.grant) ?? 'client_credentials';
    const clientId = optionalString(auth.clientId);
    if (!clientId) {
        throw new CustomMcpConfigError(serverName, 'auth.clientId', 'required for oauth');
    }
    const scope = optionalString(auth.scope);

    if (grant === 'client_credentials') {
        rejectUnexpectedFields(
            serverName,
            auth,
            ['type', 'grant', 'clientId', 'clientSecret', 'scope'],
            'auth.',
        );
        const clientSecret = optionalString(auth.clientSecret);
        if (!clientSecret) {
            throw new CustomMcpConfigError(serverName, 'auth.clientSecret', 'required for client_credentials');
        }
        return {
            type: 'oauth',
            grant: 'client_credentials',
            clientId,
            clientSecret,
            scope,
        };
    }

    if (grant === 'authorization_code') {
        rejectUnexpectedFields(
            serverName,
            auth,
            ['type', 'grant', 'clientId', 'clientSecret', 'redirectUri', 'tokenStore', 'scope'],
            'auth.',
        );
        const tokenStore = optionalString(auth.tokenStore);
        if (!tokenStore) {
            throw new CustomMcpConfigError(serverName, 'auth.tokenStore', 'required for authorization_code');
        }
        if (!configPath) {
            throw new CustomMcpConfigError(serverName, 'auth.tokenStore', 'configPath is required to resolve token stores');
        }
        const redirectUri = optionalString(auth.redirectUri) ?? DEFAULT_REDIRECT_URI;
        parseLoopbackRedirectUri(redirectUri, serverName);
        const resolvedStore = isAbsolute(tokenStore)
            ? tokenStore
            : resolve(dirname(configPath), tokenStore);
        return {
            type: 'oauth',
            grant: 'authorization_code',
            clientId,
            clientSecret: optionalString(auth.clientSecret),
            redirectUri,
            tokenStore: resolvedStore,
            scope,
        };
    }

    throw new CustomMcpConfigError(serverName, 'auth.grant', `unsupported value "${grant}"`);
}

export function normalizeCustomMcpServer(
    raw: unknown,
    configPath: string,
    index: number,
): NormalizedCustomMcpServer {
    const rec = asRecord(raw);
    if (!rec) {
        throw new CustomMcpConfigError(`#${index}`, 'server', 'must be an object');
    }
    const name = optionalString(rec.name);
    if (!name) {
        throw new CustomMcpConfigError(`#${index}`, 'name', 'required');
    }
    rejectUnexpectedFields(name, rec, ['name', 'url', 'auth', 'enabled'], '');
    if (rec.enabled !== undefined && typeof rec.enabled !== 'boolean') {
        throw new CustomMcpConfigError(name, 'enabled', 'must be a boolean');
    }
    const url = optionalString(rec.url);
    if (!url) {
        throw new CustomMcpConfigError(name, 'url', 'required');
    }
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('unsupported protocol');
        }
    } catch {
        throw new CustomMcpConfigError(name, 'url', 'must be an http or https URL');
    }
    return {
        name,
        url,
        auth: normalizeCustomMcpAuth(name, rec.auth, configPath),
    };
}

export interface LoadedCustomMcpServers {
    servers: NormalizedCustomMcpServer[];
    skipped: CustomMcpConfigError[];
}

export function loadCustomMcpServers(
    configs: CustomMcpServerConfig[] | undefined,
    configPath: string,
): LoadedCustomMcpServers {
    const skipped: CustomMcpConfigError[] = [];
    const enabledRaw = (configs ?? []).filter((c) => c && c.enabled !== false);
    const names = new Map<string, number>();
    const servers: NormalizedCustomMcpServer[] = [];

    enabledRaw.forEach((raw, index) => {
        try {
            const normalized = normalizeCustomMcpServer(raw, configPath, index);
            const count = (names.get(normalized.name) ?? 0) + 1;
            names.set(normalized.name, count);
            servers.push(normalized);
        } catch (err) {
            if (err instanceof CustomMcpConfigError) {
                skipped.push(err);
            } else {
                skipped.push(new CustomMcpConfigError(`#${index}`, 'server', (err as Error).message));
            }
        }
    });

    const unique: NormalizedCustomMcpServer[] = [];
    for (const server of servers) {
        if ((names.get(server.name) ?? 0) > 1) {
            skipped.push(new CustomMcpConfigError(server.name, 'name', 'duplicate server name'));
            continue;
        }
        unique.push(server);
    }

    return { servers: unique, skipped };
}

export function findAuthorizationCodeServer(
    configs: unknown,
    configPath: string,
    serverName: string,
): NormalizedCustomMcpServer {
    if (!Array.isArray(configs)) {
        throw new CustomMcpConfigError(serverName, 'customMcpServers', 'must be an array');
    }

    const matches = configs.filter((entry) => {
        const rec = asRecord(entry);
        return rec && optionalString(rec.name) === serverName;
    });
    if (matches.length === 0) {
        throw new CustomMcpConfigError(serverName, 'name', 'server not found');
    }
    if (matches.length > 1) {
        throw new CustomMcpConfigError(serverName, 'name', 'duplicate server name');
    }

    const rec = asRecord(matches[0])!;
    if (rec.enabled === false) {
        throw new CustomMcpConfigError(serverName, 'enabled', 'server is disabled');
    }

    const normalized = normalizeCustomMcpServer(rec, configPath, 0);
    if (normalized.auth.type !== 'oauth' || normalized.auth.grant !== 'authorization_code') {
        throw new CustomMcpConfigError(serverName, 'auth.grant', 'must be oauth authorization_code');
    }
    return normalized;
}

export type { CustomMcpAuth, CustomMcpServerConfig };
