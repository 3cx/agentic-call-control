import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpAuthProvider } from '@3cx/call-control-sdk';
import chalk from 'chalk';
import { callMcpTool as rawCallMcpTool } from './mcp-client.ts';

export interface McpManagerConfig {
    mcpUrl: string;
    authProvider: McpAuthProvider;
    healthIntervalMs?: number;
}

export class McpManager {
    private client: Client | null = null;
    private connected = false;
    private healthTimer: ReturnType<typeof setInterval> | null = null;
    private config: McpManagerConfig;

    constructor(config: McpManagerConfig) {
        this.config = config;
    }

    async connect(): Promise<void> {
        const tokenResponse = await this.config.authProvider.tokens();

        const transport = new StreamableHTTPClientTransport(
            new URL(this.config.mcpUrl),
            {
                requestInit: {
                    headers: {
                        Authorization: `${tokenResponse.token_type} ${tokenResponse.access_token}`,
                    },
                },
            },
        );

        this.client = new Client(
            { name: 'agentic-call-control', version: '1.0.0' },
            { capabilities: {} },
        );

        await this.client.connect(transport);
        this.connected = true;
        console.log(chalk.green('[McpManager] connected to', this.config.mcpUrl));

        this.startHealthCheck();
    }

    async ensureConnected(): Promise<Client> {
        if (this.connected && this.client) return this.client;

        console.log(chalk.yellow('[McpManager] reconnecting...'));
        try {
            await this.connect();
        } catch (err) {
            console.error(chalk.red('[McpManager] reconnect failed:'), (err as Error).message);
            throw err;
        }
        return this.client!;
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
        const client = await this.ensureConnected();
        try {
            return await rawCallMcpTool(client, name, args);
        } catch (err) {
            const msg = (err as Error).message ?? '';
            const isConnectionError = /ECONNREFUSED|ENOTFOUND|HTTP error|fetch failed|network/i.test(msg);
            if (!isConnectionError) throw err;

            console.log(chalk.yellow(`[McpManager] tool "${name}" failed, reconnecting: ${msg}`));
            this.connected = false;
            try {
                const retryClient = await this.ensureConnected();
                return await rawCallMcpTool(retryClient, name, args);
            } catch {
                console.error(chalk.red(`[McpManager] retry failed for "${name}"`));
                return `MCP unavailable — could not reach tool "${name}". Try again later.`;
            }
        }
    }

    isHealthy(): boolean {
        return this.connected && this.client !== null;
    }

    getClient(): Client | null {
        return this.client;
    }

    async listTools() {
        const client = await this.ensureConnected();
        return client.listTools();
    }

    private startHealthCheck(): void {
        if (this.healthTimer) clearInterval(this.healthTimer);
        const interval = this.config.healthIntervalMs ?? 60_000;
        this.healthTimer = setInterval(() => this.healthCheck(), interval);
    }

    private async healthCheck(): Promise<void> {
        if (!this.client) return;
        try {
            await this.client.listTools();
        } catch {
            console.warn(chalk.yellow('[McpManager] health check failed, marking unhealthy'));
            this.connected = false;
            try {
                await this.connect();
                console.log(chalk.green('[McpManager] proactive reconnect succeeded'));
            } catch (err) {
                console.error(chalk.red('[McpManager] proactive reconnect failed:'), (err as Error).message);
            }
        }
    }

    dispose(): void {
        if (this.healthTimer) clearInterval(this.healthTimer);
        this.client = null;
        this.connected = false;
    }
}
