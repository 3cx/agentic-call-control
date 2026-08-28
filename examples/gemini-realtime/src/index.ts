import chalk from 'chalk';
import { CallControlClient } from '@3cx/call-control-sdk';
import { createCallStore } from './callcontrol/call-store.ts';
import { connectMcp, filterMcpTools, connectCustomMcpServers } from '@3cx-examples/mcp';
import type { CustomMcpRouter } from '@3cx-examples/mcp';
import type { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import appconfig from './app-config.ts';
import { loadAgentProfile } from './agent/agent-profiles.ts';
import type { AgentProfile } from './agent/agent-profiles.ts';

async function main() {
    console.log(chalk.cyan('gemini-realtime starting'));
    console.log(chalk.cyan(`   3CX PBX: ${appconfig.pbxBase}`));

    if (!appconfig.geminiApiKey) {
        console.error(chalk.red('Error: geminiApiKey is missing in config.yaml'));
        process.exit(1);
    }

    let profile: AgentProfile | null = null;

    if (appconfig.agentProfile) {
        profile = loadAgentProfile(appconfig.agentProfile);
        console.log(chalk.cyan(`   Agent profile: ${appconfig.agentProfile} (role: ${profile.role})`));
    } else if (appconfig.agentInstructions) {
        console.log(chalk.cyan('   Agent: legacy agentInstructions mode'));
    } else {
        console.error(chalk.red('Error: neither agentProfile nor agentInstructions is set in config.yaml'));
        process.exit(1);
    }

    console.log(chalk.cyan(`   Gemini Voice: ${profile?.voice ?? appconfig.geminiVoice ?? 'Kore'}`));

    const client = new CallControlClient({
        pbxBase: appconfig.pbxBase,
        appId: appconfig.appId,
        appSecret: appconfig.appSecret,
    });

    await client.connect();
    console.log(chalk.green('   SDK connected (auth + WebSocket + state)'));

    let mcpClient: McpClient | undefined;
    let mcpToolDefs: { name: string; description: string; parameters: Record<string, unknown> }[] = [];

    try {
        mcpClient = await connectMcp(
            client.getMcpUrl(),
            client.createMcpAuthProvider(),
        );

        const toolsResult = await mcpClient.listTools();
        const filtered = filterMcpTools(toolsResult.tools, profile?.mcpTools);
        const filteredNames = new Set(filtered.map((t) => t.name));

        mcpToolDefs = filtered.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        }));

        console.log(chalk.cyan(`   MCP tools (${filtered.length}/${toolsResult.tools.length}):`));
        for (const t of toolsResult.tools) {
            const enabled = filteredNames.has(t.name);
            const label = enabled ? chalk.green('✓') : chalk.gray('✗');
            const color = enabled ? chalk.gray : chalk.dim;
            console.log(color(`     ${label} ${t.name}: ${t.description ?? '(no description)'}`));
        }
    } catch (err) {
        console.warn(chalk.yellow('[MCP] connection failed, continuing without MCP tools:'), (err as Error).message);
    }

    const customMcpRouter: CustomMcpRouter | undefined = await connectCustomMcpServers(
        appconfig.customMcpServers,
        profile?.mcpTools,
    );

    createCallStore(client, appconfig, profile, mcpClient, mcpToolDefs, customMcpRouter);

    console.log(chalk.green('All systems ready (Gemini Live mode)'));
}

main().catch((err) => {
    console.error(chalk.red('Fatal error:'), err);
    process.exit(1);
});
