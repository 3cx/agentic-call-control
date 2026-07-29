/**
 * Optional extra MCP servers (beyond the built-in 3CX `{pbxBase}/mcp`).
 * Pattern mirrors voice-agent-orchestrator CustomMcpConnection + CustomMcpRouter:
 * connect N servers → merge tools → route callTool by tool name.
 *
 * Enable via config.yaml `customMcpServers`. Empty / omitted = no-op (3CX MCP only).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import chalk from 'chalk';
import type { McpToolDefinition } from './mcp-client.ts';
import { coerceToolArguments } from './tool-schema.ts';

export type CustomMcpAuth =
    | { type: 'none' }
    | { type: 'bearer'; token: string };

export interface CustomMcpServerConfig {
    name: string;
    url: string;
    auth?: CustomMcpAuth;
    /** Defaults to true when omitted. */
    enabled?: boolean;
}

export interface CustomMcpToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

function authHeaders(auth?: CustomMcpAuth): Record<string, string> {
    if (auth?.type === 'bearer' && auth.token) {
        return { Authorization: `Bearer ${auth.token}` };
    }
    return {};
}

export class CustomMcpConnection {
    private client: Client | null = null;
    private readonly cfg: CustomMcpServerConfig;
    public readonly name: string;
    public tools: McpToolDefinition[] = [];

    constructor(cfg: CustomMcpServerConfig) {
        this.cfg = cfg;
        this.name = cfg.name;
    }

    async connect(): Promise<void> {
        const transport = new StreamableHTTPClientTransport(
            new URL(this.cfg.url),
            { requestInit: { headers: authHeaders(this.cfg.auth) } },
        );

        this.client = new Client(
            { name: 'agentic-call-control', version: '1.0.0' },
            { capabilities: {} },
        );
        await this.client.connect(transport);

        const { tools } = await this.client.listTools();
        this.tools = tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown> | undefined,
        }));

        console.log(chalk.green(`[CustomMCP] "${this.name}" connected — ${this.tools.length} tools`));
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
        if (!this.client) throw new Error(`CustomMCP "${this.name}" not connected`);
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
    }

    disconnect(): void {
        void this.client?.close?.().catch(() => undefined);
        this.client = null;
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

    disconnectAll(): void {
        for (const conn of this.connections) conn.disconnect();
    }
}

/** Connect enabled custom MCP servers from config. Returns undefined when none configured. */
export async function connectCustomMcpServers(
    configs: CustomMcpServerConfig[] | undefined,
    allowlist?: string[] | 'all',
): Promise<CustomMcpRouter | undefined> {
    const enabled = (configs ?? []).filter((c) => c.enabled !== false && c.name && c.url);
    if (enabled.length === 0) return undefined;

    const connected: CustomMcpConnection[] = [];
    for (const cfg of enabled) {
        const conn = new CustomMcpConnection(cfg);
        try {
            await conn.connect();
            connected.push(conn);
        } catch (err) {
            console.warn(
                chalk.yellow(`[CustomMCP] "${cfg.name}" failed, skipping:`),
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
