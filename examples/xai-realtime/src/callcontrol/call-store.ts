import chalk from 'chalk';
import type { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';

import type { CallControlClient, Participant } from '@3cx/call-control-sdk';
import type { AppConfig } from '../app-config.ts';
import type { AgentProfile } from '../agent/agent-profiles.ts';
import { renderPrompt } from '../agent/agent-profiles.ts';
import { createCallState } from '../agent/call-state.ts';
import { buildLocalTools } from '../agent/local-tools.ts';
import { createToolExecutor } from '../agent/tool-executor.ts';
import { createXaiRealtimeBridge } from '../providers/xai-realtime.ts';
import type { XaiBridgeHandle, XaiToolDef } from '../providers/xai-realtime.ts';
import { getCallLogger } from '@3cx-examples/logger';
import type { CallLogger } from '@3cx-examples/logger';
import type { CustomMcpRouter } from '@3cx-examples/mcp';

interface McpToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

interface ParticipantState {
    bridge: XaiBridgeHandle;
    logger: CallLogger;
}

export function createCallStore(
    client: CallControlClient,
    appConfig: AppConfig,
    profile: AgentProfile | null,
    mcpClient?: McpClient,
    mcpToolDefs?: McpToolDef[],
    customMcpRouter?: CustomMcpRouter,
) {
    const participantState = new Map<number, ParticipantState>();

    const mcpToolNames = new Set((mcpToolDefs ?? []).map((t) => t.name));

    const cleanup = (participantId: number) => {
        const st = participantState.get(participantId);
        if (!st) return;
        st.bridge.stop();
        st.logger.callEnd();
        participantState.delete(participantId);
        console.log(chalk.yellow(`[CallStore] bridge stopped for participant ${participantId}`));
    };

    const handleParticipantConnected = (participant: Participant) => {
        if (participantState.has(participant.id)) return;

        console.log(chalk.green(`[CallStore] participant ${participant.id} connected`));

        const callerName = participant.info.party_caller_name ?? '';
        const callerNumber = participant.info.party_caller_id ?? '';
        const logger = getCallLogger(participant.id, { tag: 'xAI' });
        logger.callStart(callerName, callerNumber);
        const callState = createCallState(callerName, callerNumber);

        const instructions = profile
            ? renderPrompt(profile, {
                company_name: appConfig.companyName ?? '',
                agent_name: appConfig.agentName ?? '',
                caller_name: callerName,
                caller_number: callerNumber,
            })
            : (appConfig.agentInstructions ?? '');

        const localToolDefs = buildLocalTools({ callScreening: profile?.callScreening });

        // Merge local tools + MCP tools (both as xAI function tools)
        const allTools: XaiToolDef[] = [
            ...localToolDefs.map((t) => ({
                type: 'function' as const,
                name: t.function.name,
                description: t.function.description ?? '',
                parameters: (t.function.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
            })),
            ...(mcpToolDefs ?? []).map((t) => ({
                type: 'function' as const,
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            })),
            ...(customMcpRouter?.toolDefs ?? []).map((t) => ({
                type: 'function' as const,
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            })),
        ];

        const toolExecutor = createToolExecutor({
            participant,
            mcpClient,
            mcpToolNames,
            customMcpRouter,
            profile: profile ?? { role: '', prompt: '', allowedActions: [] },
            callState,
            onCleanup: () => cleanup(participant.id),
            logger,
        });

        logger.info(`TOOLS_AVAILABLE | count=${allTools.length} names=${allTools.map((t) => t.name).join(',')}`);
        console.log(chalk.gray(`[CallStore] tools (${allTools.length}): ${allTools.map((t) => t.name).join(', ')}`));

        const bridge = createXaiRealtimeBridge(
            participant,
            {
                xaiApiKey: appConfig.xaiApiKey,
                model: appConfig.xaiModel,
                voice: profile?.voice ?? appConfig.xaiVoice ?? 'tara',
                instructions,
                vadSilenceDurationMs: appConfig.xaiVadSilenceDurationMs,
                localTools: allTools,
                openingLine: profile?.greeting
                    ? profile.greeting
                        .replace(/\{\{company_name\}\}/g, appConfig.companyName ?? '')
                        .replace(/\{\{agent_name\}\}/g, appConfig.agentName ?? '')
                    : (appConfig.initialGreeting ?? 'Thank you for calling. How can I help you?'),
                speakOnRouteFailure: appConfig.speakOnRouteFailure,
                routeFailureUserReply: appConfig.routeFailureUserReply,
                logger,
            },
            (name, argsJson) => toolExecutor.execute(name, argsJson),
        );

        participantState.set(participant.id, { bridge, logger });
        console.log(chalk.green(`[CallStore] xAI realtime bridge started for participant ${participant.id}`));
    };

    const handleParticipantDisconnected = (participantId: number) => {
        const st = participantState.get(participantId);
        st?.logger.info('PARTICIPANT_DISCONNECTED');
        console.log(chalk.green(`[CallStore] participant ${participantId} disconnected`));
        cleanup(participantId);
    };

    client.on('participantConnected', handleParticipantConnected);
    client.on('participantDisconnected', handleParticipantDisconnected);

    console.log(chalk.cyan('[CallStore] initialized (xAI realtime mode)'));
}
