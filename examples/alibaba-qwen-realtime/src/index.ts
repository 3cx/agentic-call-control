import chalk from 'chalk';
import { CallControlClient } from '@3cx/call-control-sdk';
import { createCallStore } from './callcontrol/call-store.ts';
import { filterMcpTools, McpManager, connectCustomMcpServers } from '@3cx-examples/mcp';
import type { CustomMcpRouter } from '@3cx-examples/mcp';
import appconfig from './app-config.ts';
import { loadAgentProfile } from './agent/agent-profiles.ts';
import type { AgentProfile } from './agent/agent-profiles.ts';

async function main() {
    console.log(chalk.cyan('alibaba-qwen-realtime starting'));
    console.log(chalk.cyan(`   3CX PBX: ${appconfig.pbxBase}`));
    console.log(chalk.cyan(`   DashScope: ${appconfig.dashscopeBaseUrl}`));
    console.log(chalk.cyan(`   Model: ${appconfig.realtimeModel ?? 'qwen3.5-omni-plus-realtime'}`));

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

    console.log(chalk.cyan(`   Voice: ${profile?.voice ?? appconfig.realtimeVoice ?? 'Ethan'}`));

    const client = new CallControlClient({
        pbxBase: appconfig.pbxBase,
        appId: appconfig.appId,
        appSecret: appconfig.appSecret,
    });

    await client.connect();
    console.log(chalk.green('   SDK connected (auth + WebSocket + state)'));

    let mcpManager: McpManager | undefined;
    let mcpToolDefs: { name: string; description: string; parameters: Record<string, unknown> }[] = [];

    try {
        mcpManager = new McpManager({
            mcpUrl: client.getMcpUrl(),
            authProvider: client.createMcpAuthProvider(),
        });
        await mcpManager.connect();

        const toolsResult = await mcpManager.listTools();
        const filtered = filterMcpTools(toolsResult.tools, profile?.mcpTools);
        mcpToolDefs = filtered.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        }));

        console.log(chalk.cyan(`   MCP tools (${filtered.length}/${toolsResult.tools.length}):`));
        for (const t of filtered) {
            console.log(chalk.gray(`     - ${t.name}: ${t.description ?? '(no description)'}`));
        }
    } catch (err) {
        console.warn(chalk.yellow('[MCP] connection failed, continuing without MCP tools:'), (err as Error).message);
        mcpManager = undefined;
        mcpToolDefs = [];
    }

    const customMcpRouter: CustomMcpRouter | undefined = await connectCustomMcpServers(
        appconfig.customMcpServers,
        profile?.mcpTools,
    );

    createCallStore(client, appconfig, profile, mcpManager, mcpToolDefs, customMcpRouter);

    console.log(chalk.green('All systems ready (Qwen realtime mode)'));
}

main().catch((err) => {
    console.error(chalk.red('Fatal error:'), err);
    process.exit(1);
});
