import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpAuthProvider } from '@3cx/call-control-sdk';
import chalk from 'chalk';

export async function connectMcp(
    mcpUrl: string,
    authProvider: McpAuthProvider,
): Promise<Client> {
    const tokenResponse = await authProvider.tokens();

    const transport = new StreamableHTTPClientTransport(
        new URL(mcpUrl),
        {
            requestInit: {
                headers: {
                    Authorization: `${tokenResponse.token_type} ${tokenResponse.access_token}`,
                },
            },
        },
    );

    const client = new Client(
        { name: 'agentic-call-control', version: '1.0.0' },
        { capabilities: {} },
    );

    await client.connect(transport);
    console.log(chalk.green('[MCP] connected to', mcpUrl));

    return client;
}

export interface McpToolDefinition {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

export function filterMcpTools(
    tools: McpToolDefinition[],
    filter?: string[] | 'all',
): McpToolDefinition[] {
    if (!filter || filter === 'all') return tools;
    const allowed = new Set(filter);
    return tools.filter((t) => allowed.has(t.name));
}

export async function callMcpTool(
    client: Client,
    name: string,
    args: Record<string, unknown>,
): Promise<string> {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
        const errText = typeof result.content === 'string'
            ? result.content
            : JSON.stringify(result.content);
        throw new Error(`MCP tool "${name}" error: ${errText}`);
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
