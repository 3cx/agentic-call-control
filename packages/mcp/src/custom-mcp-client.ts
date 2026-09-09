/**
 * Optional extra MCP servers (beyond the built-in 3CX `{pbxBase}/mcp`).
 * Pattern mirrors voice-agent-orchestrator CustomMcpConnection + CustomMcpRouter:
 * connect N servers → merge tools → route callTool by tool name.
 *
 * Enable via config.yaml `customMcpServers`. Empty / omitted = no-op (3CX MCP only).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
    StreamableHTTPClientTransport,
    StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { ClientCredentialsProvider } from '@modelcontextprotocol/sdk/client/auth-extensions.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import chalk from 'chalk';
import type { McpToolDefinition } from './mcp-client.ts';
import { coerceToolArguments } from './tool-schema.ts';
import {
    InteractiveAuthRequiredError,
    mcpAuthRecoveryCommand,
    type CustomMcpAuth,
    type CustomMcpServerConfig,
} from './custom-mcp-auth.ts';
import { loadCustomMcpServers, type NormalizedCustomMcpServer } from './custom-mcp-config.ts';
import { FileBackedAuthCodeProvider } from './oauth-auth-code-provider.ts';

export type { CustomMcpAuth, CustomMcpServerConfig };

export interface CustomMcpToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface ConnectCustomMcpOptions {
    /** Absolute or process-resolved path of the example config.yaml. Required for authorization_code token stores. */
    configPath: string;
}

const MCP_UNAVAILABLE = (name: string, extra?: string) => (
    extra
        ? `MCP unavailable — could not reach tool "${name}". ${extra}`
        : `MCP unavailable — could not reach tool "${name}". Try again later.`
);

function isOAuthCredentialFailure(err: unknown): boolean {
    return err instanceof UnauthorizedError
        || err instanceof InteractiveAuthRequiredError
        || err instanceof OAuthError
        || (err instanceof StreamableHTTPError && err.code === 401);
}

function authHeaders(auth: NormalizedCustomMcpServer['auth']): Record<string, string> {
    if (auth.type === 'bearer' && auth.token) {
        return { Authorization: `Bearer ${auth.token}` };
    }
    return {};
}

function createAuthProvider(
    server: NormalizedCustomMcpServer,
    configPath: string,
    interactive: boolean,
): OAuthClientProvider | undefined {
    if (server.auth.type !== 'oauth') return undefined;
    if (server.auth.grant === 'client_credentials') {
        return new ClientCredentialsProvider({
            clientId: server.auth.clientId,
            clientSecret: server.auth.clientSecret,
            clientName: 'agentic-call-control',
            scope: server.auth.scope,
        });
    }
    return new FileBackedAuthCodeProvider({
        serverName: server.name,
        mcpUrl: server.url,
        auth: server.auth,
        configPath,
        interactive,
    });
}

export class CustomMcpConnection {
    private client: Client | null = null;
    private transport: StreamableHTTPClientTransport | null = null;
    private authProvider: OAuthClientProvider | undefined;
    private connected = false;
    private unavailableMessage: string | undefined;
    private connectFlight: Promise<void> | null = null;
    public readonly name: string;
    public tools: McpToolDefinition[] = [];
    private readonly server: NormalizedCustomMcpServer;
    private readonly configPath: string;

    constructor(server: NormalizedCustomMcpServer, configPath: string) {
        this.server = server;
        this.configPath = configPath;
        this.name = server.name;
    }

    recoveryCommand(): string {
        return mcpAuthRecoveryCommand(this.configPath, this.name);
    }

    isUnavailable(): boolean {
        return this.unavailableMessage !== undefined;
    }

    async connect(): Promise<void> {
        return this.connectSingleFlight(true);
    }

    private async reconnectAfterUnauthorized(): Promise<void> {
        return this.connectSingleFlight(false);
    }

    private async connectSingleFlight(allowCredentialRecreate: boolean): Promise<void> {
        if (this.connectFlight) return this.connectFlight;
        this.connectFlight = this.connectInternal(allowCredentialRecreate).finally(() => {
            this.connectFlight = null;
        });
        return this.connectFlight;
    }

    private async connectInternal(allowCredentialRecreate: boolean): Promise<void> {
        await this.closeClient();
        this.unavailableMessage = undefined;
        this.authProvider = createAuthProvider(this.server, this.configPath, false);

        if (this.server.auth.type === 'oauth' && this.server.auth.grant === 'authorization_code') {
            const cmd = this.recoveryCommand();
            try {
                const stored = await (this.authProvider as FileBackedAuthCodeProvider).store.read();
                if (!stored?.tokens) {
                    await this.markUnavailable(`Authorize with: ${cmd}`);
                    throw new InteractiveAuthRequiredError(cmd);
                }
            } catch (err) {
                if (err instanceof InteractiveAuthRequiredError) throw err;
                await this.markUnavailable(`Authorize with: ${cmd}`);
                throw new InteractiveAuthRequiredError(cmd);
            }
        }

        const headers = authHeaders(this.server.auth);
        this.transport = new StreamableHTTPClientTransport(
            new URL(this.server.url),
            {
                ...(this.authProvider ? { authProvider: this.authProvider } : {}),
                ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
            },
        );

        this.client = new Client(
            { name: 'agentic-call-control', version: '1.0.0' },
            { capabilities: {} },
        );

        try {
            await this.client.connect(this.transport);
            const { tools } = await this.client.listTools();
            this.tools = tools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema as Record<string, unknown> | undefined,
            }));
        } catch (err) {
            if (this.server.auth.type === 'oauth' && this.server.auth.grant === 'authorization_code' && isOAuthCredentialFailure(err)) {
                const cmd = this.recoveryCommand();
                await this.markUnavailable(`Authorize with: ${cmd}`);
                throw new InteractiveAuthRequiredError(cmd);
            }
            if (this.server.auth.type === 'oauth' && this.server.auth.grant === 'client_credentials' && isOAuthCredentialFailure(err)) {
                if (allowCredentialRecreate) {
                    await this.closeClient();
                    return this.connectInternal(false);
                }
            }
            await this.closeClient();
            throw err;
        }

        this.connected = true;
        console.log(chalk.green(`[CustomMCP] "${this.name}" connected — ${this.tools.length} tools`));
    }

    private async markUnavailable(detail: string): Promise<void> {
        this.unavailableMessage = detail;
        this.connected = false;
        this.tools = [];
        await this.closeClient();
        console.warn(chalk.yellow(`[CustomMCP] "${this.name}" skipped. ${detail}`));
    }

    private async closeClient(): Promise<void> {
        const transport = this.transport;
        const client = this.client;
        this.transport = null;
        this.client = null;
        this.authProvider = undefined;
        this.connected = false;
        try {
            await client?.close();
        } catch {
            // ignore
        }
        try {
            await transport?.close();
        } catch {
            // ignore
        }
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
        if (this.unavailableMessage) {
            return MCP_UNAVAILABLE(name, this.unavailableMessage);
        }
        if (!this.client) throw new Error(`CustomMCP "${this.name}" not connected`);
        try {
            const result = await this.client.callTool({ name, arguments: args });
            if (result.isError) {
                const errText = typeof result.content === 'string'
                    ? result.content
                    : JSON.stringify(result.content);
                throw new Error(`Custom MCP tool "${name}" error: ${errText}`);
            }
            if (typeof result.content === 'string') return result.content;
            if (Array.isArray(result.content)) {
                return result.content
                    .map((c) => {
                        if (typeof c === 'string') return c;
                        if (c.type === 'text') return (c as { text: string }).text;
                        return JSON.stringify(c);
                    })
                    .join('\n');
            }
            return JSON.stringify(result.content);
        } catch (err) {
            if (this.server.auth.type === 'oauth' && this.server.auth.grant === 'authorization_code' && isOAuthCredentialFailure(err)) {
                const cmd = this.recoveryCommand();
                await this.markUnavailable(`Authorize with: ${cmd}`);
                return MCP_UNAVAILABLE(name, `Authorize with: ${cmd}`);
            }
            if (this.server.auth.type === 'oauth' && this.server.auth.grant === 'client_credentials' && isOAuthCredentialFailure(err)) {
                try {
                    await this.reconnectAfterUnauthorized();
                    if (!this.client) return MCP_UNAVAILABLE(name);
                    const retry = await this.client.callTool({ name, arguments: args });
                    if (retry.isError) return MCP_UNAVAILABLE(name);
                    if (typeof retry.content === 'string') return retry.content;
                    return JSON.stringify(retry.content);
                } catch {
                    return MCP_UNAVAILABLE(name);
                }
            }
            throw err;
        }
    }

    async disconnect(): Promise<void> {
        await this.closeClient();
    }
}

/** Routes tool calls to the connection that registered that tool name. */
export class CustomMcpRouter {
    private readonly registry = new Map<string, CustomMcpConnection>();
    private readonly schemaByName = new Map<string, Record<string, unknown>>();
    private readonly connections: CustomMcpConnection[];
    /** All tools discovered from custom servers (before allowlist). */
    public readonly allToolDefs: CustomMcpToolDef[] = [];
    /** Tools exposed to the agent (after allowlist). */
    public readonly toolDefs: CustomMcpToolDef[] = [];

    constructor(connections: CustomMcpConnection[]) {
        this.connections = connections;
        for (const conn of connections) {
            for (const tool of conn.tools) {
                if (this.registry.has(tool.name)) {
                    console.warn(chalk.yellow(
                        `[CustomMCP] duplicate tool "${tool.name}" from "${conn.name}" — overrides previous server`,
                    ));
                }
                const def: CustomMcpToolDef = {
                    name: tool.name,
                    description: tool.description ?? '',
                    parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
                };
                this.registry.set(tool.name, conn);
                this.schemaByName.set(tool.name, def.parameters);
                this.allToolDefs.push(def);
                this.toolDefs.push(def);
            }
        }
    }

    /**
     * Restrict exposed/callable tools to the agent profile `mcpTools` allowlist.
     * Same semantics as filterMcpTools for 3CX MCP (`undefined` / `'all'` = keep everything).
     */
    applyAllowlist(filter?: string[] | 'all'): void {
        if (!filter || filter === 'all') return;

        const allowed = new Set(filter);
        this.toolDefs.length = 0;
        this.registry.clear();
        this.schemaByName.clear();

        for (const conn of this.connections) {
            for (const tool of conn.tools) {
                if (!allowed.has(tool.name)) continue;
                const parameters = (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} };
                this.registry.set(tool.name, conn);
                this.schemaByName.set(tool.name, parameters);
                this.toolDefs.push({
                    name: tool.name,
                    description: tool.description ?? '',
                    parameters,
                });
            }
        }
    }

    has(toolName: string): boolean {
        return this.registry.has(toolName);
    }

    async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
        const conn = this.registry.get(toolName);
        if (!conn) return `Unknown custom MCP tool: ${toolName}`;
        const coerced = coerceToolArguments(args, this.schemaByName.get(toolName));
        return conn.callTool(toolName, coerced);
    }

    async disconnectAll(): Promise<void> {
        await Promise.all(this.connections.map((conn) => conn.disconnect()));
    }
}

/** Connect enabled custom MCP servers from config. Returns undefined when none configured. */
export async function connectCustomMcpServers(
    configs: CustomMcpServerConfig[] | undefined,
    allowlist?: string[] | 'all',
    options?: ConnectCustomMcpOptions,
): Promise<CustomMcpRouter | undefined> {
    const configPath = options?.configPath ?? '';
    const loaded = loadCustomMcpServers(configs, configPath);
    for (const err of loaded.skipped) {
        console.warn(chalk.yellow(err.message));
    }
    if (loaded.servers.length === 0) return undefined;

    const connected: CustomMcpConnection[] = [];
    for (const server of loaded.servers) {
        const conn = new CustomMcpConnection(server, configPath);
        try {
            await conn.connect();
            connected.push(conn);
        } catch (err) {
            if (err instanceof InteractiveAuthRequiredError) {
                console.warn(
                    chalk.yellow(`[CustomMCP] "${server.name}" failed, skipping:`),
                    err.message,
                );
                continue;
            }
            console.warn(
                chalk.yellow(`[CustomMCP] "${server.name}" failed, skipping:`),
                (err as Error).message,
            );
        }
    }

    if (connected.length === 0) return undefined;
    const router = new CustomMcpRouter(connected);
    router.applyAllowlist(allowlist);

    const enabledNames = new Set(router.toolDefs.map((t) => t.name));
    console.log(chalk.cyan(
        `   Custom MCP tools (${router.toolDefs.length}/${router.allToolDefs.length}):`,
    ));
    for (const t of router.allToolDefs) {
        const on = enabledNames.has(t.name);
        const label = on ? chalk.green('✓') : chalk.gray('✗');
        const color = on ? chalk.gray : chalk.dim;
        const desc = (t.description || '(no description)').replace(/\s+/g, ' ').trim();
        const short = desc.length > 100 ? `${desc.slice(0, 100)}…` : desc;
        console.log(color(`     ${label} ${t.name}: ${short}`));
    }

    return router;
}
