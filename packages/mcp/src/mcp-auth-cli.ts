import { createInterface } from 'node:readline/promises';
import { stdin as defaultStdin, stdout as defaultStdout, stderr as defaultStderr } from 'node:process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import chalk from 'chalk';
import { load } from 'js-yaml';
import { CustomMcpConfigError } from './custom-mcp-auth.ts';
import { findAuthorizationCodeServer } from './custom-mcp-config.ts';
import { FileBackedAuthCodeProvider } from './oauth-auth-code-provider.ts';
import {
    DEFAULT_CALLBACK_TIMEOUT_MS,
    OAuthCallbackError,
    startLoopbackCallback,
} from './oauth-callback-server.ts';
import { TokenStoreLock, TokenStoreLockError } from './oauth-token-store.ts';

export interface McpAuthIo {
    stdin: NodeJS.ReadableStream & { isTTY?: boolean };
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export function parseMcpAuthArgs(argv: string[]): { configPath: string; serverName: string } {
    let configPath: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--config') {
            const value = argv[++i];
            if (!value) throw new Error('--config requires a path');
            configPath = value;
            continue;
        }
        if (arg.startsWith('--config=')) {
            configPath = arg.slice('--config='.length);
            continue;
        }
        if (arg.startsWith('-')) {
            throw new Error(`Unknown argument: ${arg}`);
        }
        positional.push(arg);
    }
    if (!configPath) {
        throw new Error('Required: --config <path>');
    }
    if (positional.length !== 1) {
        throw new Error('Required: <server-name>');
    }
    return { configPath: resolve(configPath), serverName: positional[0]! };
}

function writeLine(stream: NodeJS.WritableStream, text: string): void {
    stream.write(`${text}\n`);
}

function discoveredIssuer(discovery: Awaited<ReturnType<FileBackedAuthCodeProvider['discoveryState']>>): string | undefined {
    return discovery?.authorizationServerMetadata?.issuer ?? discovery?.authorizationServerUrl;
}

function issuerRequired(discovery: Awaited<ReturnType<FileBackedAuthCodeProvider['discoveryState']>>): boolean {
    const meta = discovery?.authorizationServerMetadata as { authorization_response_iss_parameter_supported?: boolean } | undefined;
    return meta?.authorization_response_iss_parameter_supported === true;
}

async function readPastedUrl(stdin: McpAuthIo['stdin'], stdout: NodeJS.WritableStream, signal?: AbortSignal): Promise<string> {
    const rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
    try {
        return await new Promise<string>((resolvePaste, reject) => {
            const onAbort = () => {
                rl.close();
                reject(new OAuthCallbackError('Authorization cancelled'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            rl.question('Callback URL: ').then((line) => {
                signal?.removeEventListener('abort', onAbort);
                resolvePaste(line);
            }, reject);
        });
    } finally {
        rl.close();
    }
}

export async function runMcpAuth(argv: string[], io: McpAuthIo = {
    stdin: defaultStdin,
    stdout: defaultStdout,
    stderr: defaultStderr,
}): Promise<number> {
    let parsed: { configPath: string; serverName: string };
    try {
        parsed = parseMcpAuthArgs(argv);
    } catch (err) {
        writeLine(io.stderr, chalk.red((err as Error).message));
        writeLine(io.stderr, 'Usage: yarn mcp:auth --config <path> <server-name>');
        return 1;
    }

    let lock: TokenStoreLock | undefined;
    let listener: ReturnType<typeof startLoopbackCallback> | undefined;
    let client: Client | undefined;
    let transport: StreamableHTTPClientTransport | undefined;
    let verifyClient: Client | undefined;
    let verifyTransport: StreamableHTTPClientTransport | undefined;
    const timeoutMs = io.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;

    const abort = new AbortController();
    let exiting = false;

    const closeAll = async (): Promise<void> => {
        abort.abort();
        await Promise.allSettled([
            verifyClient?.close() ?? Promise.resolve(),
            verifyTransport?.close() ?? Promise.resolve(),
            client?.close() ?? Promise.resolve(),
            transport?.close() ?? Promise.resolve(),
            listener?.close() ?? Promise.resolve(),
            lock?.release() ?? Promise.resolve(),
        ]);
    };

    const onIoAbort = () => {
        abort.abort();
        void listener?.close();
    };
    io.signal?.addEventListener('abort', onIoAbort);
    if (io.signal?.aborted) onIoAbort();

    const onSig = () => {
        if (exiting) return;
        exiting = true;
        abort.abort();
        const hardExit = setTimeout(() => process.exit(1), 1000);
        void closeAll().finally(() => {
            clearTimeout(hardExit);
            process.exit(1);
        });
    };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);

    try {
        const rawYaml = await readFile(parsed.configPath, 'utf8');
        const cfg = load(rawYaml) as { customMcpServers?: unknown };
        const server = findAuthorizationCodeServer(cfg.customMcpServers, parsed.configPath, parsed.serverName);
        if (server.auth.type !== 'oauth' || server.auth.grant !== 'authorization_code') {
            throw new CustomMcpConfigError(parsed.serverName, 'auth.grant', 'must be oauth authorization_code');
        }

        lock = await TokenStoreLock.acquire(server.auth.tokenStore);

        const provider = new FileBackedAuthCodeProvider({
            serverName: server.name,
            mcpUrl: server.url,
            auth: server.auth,
            configPath: parsed.configPath,
            interactive: true,
        });
        await provider.store.assertWritableTarget();

        const expectedState = await provider.state();
        listener = startLoopbackCallback({
            redirectUri: server.auth.redirectUri,
            expectedState,
            timeoutMs,
        });
        await listener.ready();
        if (abort.signal.aborted) {
            throw new OAuthCallbackError('Authorization cancelled');
        }

        client = new Client(
            { name: 'agentic-call-control', version: '1.0.0' },
            { capabilities: {} },
        );
        transport = new StreamableHTTPClientTransport(new URL(server.url), {
            authProvider: provider,
        });

        let alreadyAuthorized = false;
        try {
            await client.connect(transport);
            alreadyAuthorized = true;
        } catch (err) {
            if (!(err instanceof UnauthorizedError) && err?.constructor?.name !== 'UnauthorizedError') {
                throw err;
            }
        }

        if (!alreadyAuthorized) {
            const discovery = await provider.discoveryState();
            const expectedIssuer = discoveredIssuer(discovery);
            const requiresIssuer = issuerRequired(discovery);
            listener.configureIssuer(expectedIssuer, requiresIssuer);

            const authUrl = provider.takeAuthorizationUrl();
            if (!authUrl) {
                throw new Error('Authorization URL was not produced by the SDK');
            }
            const port = listener.redirectUrl.port || '80';
            writeLine(io.stdout, `[CustomMCP] "${server.name}" needs authorization.`);
            writeLine(io.stdout, '');
            writeLine(io.stdout, '1. In another terminal, create an SSH tunnel:');
            writeLine(io.stdout, `   ssh -L ${port}:127.0.0.1:${port} <user>@<pbx-host>`);
            writeLine(io.stdout, '');
            writeLine(io.stdout, '2. Keep that tunnel open and visit:');
            writeLine(io.stdout, `   ${authUrl.toString()}`);
            writeLine(io.stdout, '');
            writeLine(io.stdout, `Waiting for the callback on ${listener.redirectUrl.toString()} (timeout: ${Math.round(timeoutMs / 60000)} minutes)...`);

            const callbackWait = listener.wait();
            let callback;
            if (io.stdin.isTTY) {
                writeLine(io.stdout, 'If you cannot use the tunnel, paste the full callback URL here.');
                const pasteAbort = new AbortController();
                const onParentAbort = () => pasteAbort.abort();
                abort.signal.addEventListener('abort', onParentAbort, { once: true });
                const paste = readPastedUrl(io.stdin, io.stdout, pasteAbort.signal).then((line) => {
                    listener!.acceptPastedCallbackUrl(line);
                });
                try {
                    callback = await Promise.race([
                        callbackWait,
                        paste.then(() => callbackWait),
                    ]);
                } finally {
                    abort.signal.removeEventListener('abort', onParentAbort);
                    pasteAbort.abort();
                    await paste.catch(() => undefined);
                }
            } else {
                callback = await callbackWait;
            }

            if (abort.signal.aborted) {
                throw new OAuthCallbackError('Authorization cancelled');
            }

            if (requiresIssuer && !callback.iss) {
                throw new OAuthCallbackError('Missing issuer');
            }
            if (callback.iss && expectedIssuer && callback.iss !== expectedIssuer) {
                throw new OAuthCallbackError('Issuer mismatch');
            }

            await transport.finishAuth(callback.code);
            await client.close().catch(() => undefined);
            await transport.close().catch(() => undefined);

            verifyClient = new Client(
                { name: 'agentic-call-control', version: '1.0.0' },
                { capabilities: {} },
            );
            verifyTransport = new StreamableHTTPClientTransport(new URL(server.url), {
                authProvider: provider,
            });
            await verifyClient.connect(verifyTransport);
            const tools = await verifyClient.listTools();
            writeLine(io.stdout, chalk.green(
                `[CustomMCP] "${server.name}" authorized — ${tools.tools.length} tools`,
            ));
            await verifyClient.close().catch(() => undefined);
            await verifyTransport.close().catch(() => undefined);
        } else {
            const tools = await client.listTools();
            writeLine(io.stdout, chalk.green(
                `[CustomMCP] "${server.name}" already authorized — ${tools.tools.length} tools`,
            ));
            await client.close().catch(() => undefined);
            await transport.close().catch(() => undefined);
            await listener.close();
        }

        return 0;
    } catch (err) {
        if (err instanceof TokenStoreLockError) {
            writeLine(io.stderr, chalk.red(err.message));
            return 1;
        }
        if (err instanceof CustomMcpConfigError || err instanceof OAuthCallbackError) {
            writeLine(io.stderr, chalk.red(err.message));
            return 1;
        }
        const message = err instanceof Error ? err.message : 'Authorization failed';
        writeLine(io.stderr, chalk.red(message));
        return 1;
    } finally {
        process.off('SIGINT', onSig);
        process.off('SIGTERM', onSig);
        io.signal?.removeEventListener('abort', onIoAbort);
        if (!exiting) {
            await closeAll();
        }
    }
}

const isMain = process.argv[1]?.includes('mcp-auth-cli');
if (isMain) {
    runMcpAuth(process.argv.slice(2)).then((code) => {
        process.exit(code);
    }, (err) => {
        console.error(err);
        process.exit(1);
    });
}
