import chalk from 'chalk';
import type { CallControlClient, Participant } from '@3cx/call-control-sdk';
import type { AppConfig } from '../app-config.ts';
import type { AgentProfile } from '../agent/agent-profiles.ts';
import { renderPrompt } from '../agent/agent-profiles.ts';
import { createCallState } from '../agent/call-state.ts';
import { buildLocalTools } from '../agent/local-tools.ts';
import { createToolExecutor } from '../agent/tool-executor.ts';
import { createCallLogger } from '../logging/call-logger.ts';
import type { CustomMcpRouter, McpManager } from '@3cx-examples/mcp';
import { createQwenRealtimeBridge } from '../providers/qwen-realtime.ts';
import type { QwenBridgeHandle, QwenToolDef } from '../providers/qwen-realtime.ts';
import { getCallLogger } from '@3cx-examples/logger';
import type { CallLogger as FileCallLogger } from '@3cx-examples/logger';

interface McpToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export function createCallStore(
    client: CallControlClient,
    appConfig: AppConfig,
    profile: AgentProfile | null,
    mcpManager?: McpManager,
    mcpToolDefs?: McpToolDef[],
    customMcpRouter?: CustomMcpRouter,
) {
    const participantState = new Map<number, { bridge: QwenBridgeHandle; fileLog: FileCallLogger }>();

    const cleanup = (participantId: number) => {
        const st = participantState.get(participantId);
        if (!st) return;
        st.bridge.stop();
        st.fileLog.callEnd();
        participantState.delete(participantId);
        console.log(chalk.yellow(`[CallStore] bridge stopped for participant ${participantId}`));
    };

    const handleParticipantConnected = (participant: Participant) => {
        if (participantState.has(participant.id)) return;

        console.log(chalk.green(`[CallStore] participant ${participant.id} connected`));

        const callerName = participant.info.party_caller_name ?? '';
        const callerNumber = participant.info.party_caller_id ?? '';
        const callId = `call-${participant.id}-${Date.now()}`;
        const logger = createCallLogger(callId);
        logger.event('call_start', { participantId: participant.id, mode: 'alibaba-qwen-realtime' });
        const fileLog = getCallLogger(participant.id, { tag: 'Qwen' });
        fileLog.callStart(callerName, callerNumber);

        const callState = createCallState(callerName, callerNumber);

        const localToolDefs = buildLocalTools({
            callScreening: profile?.callScreening,
        });

        const promptTools = [
            ...localToolDefs,
            ...(mcpToolDefs ?? []).map((t) => ({
                type: 'function' as const,
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                },
            })),
            ...(customMcpRouter?.toolDefs ?? []).map((t) => ({
                type: 'function' as const,
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                },
            })),
        ];

        const callContext = {
            company_name: appConfig.companyName ?? '',
            agent_name: appConfig.agentName ?? '',
            caller_name: callerName,
            caller_number: callerNumber,
        };

        const instructions = profile
            ? renderPrompt(profile, callContext, promptTools)
            : (appConfig.agentInstructions ?? '');

        const greeting = profile?.greeting
            ? profile.greeting
                .replace(/\{\{company_name\}\}/g, appConfig.companyName ?? '')
                .replace(/\{\{agent_name\}\}/g, appConfig.agentName ?? '')
            : appConfig.initialGreeting ?? '';

        const allTools: QwenToolDef[] = [
            ...localToolDefs.map((t): QwenToolDef => ({
                type: 'function',
                name: t.function.name,
                description: t.function.description ?? '',
                parameters: (t.function.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
            })),
            ...(mcpToolDefs ?? []).map((t): QwenToolDef => ({
                type: 'function',
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            })),
            ...(customMcpRouter?.toolDefs ?? []).map((t): QwenToolDef => ({
                type: 'function',
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            })),
        ];

        const toolExecutor = createToolExecutor({
            participant,
            mcpManager,
            customMcpRouter,
            profile: profile ?? { role: '', prompt: '', greeting: '' },
            callState,
            onCleanup: () => cleanup(participant.id),
            logger,
        });

        if (mcpToolDefs && mcpToolDefs.length > 0) {
            toolExecutor.setMcpToolNames(mcpToolDefs.map((t) => t.name));
        }
        if (customMcpRouter && customMcpRouter.toolDefs.length > 0) {
            toolExecutor.setCustomMcpToolNames(customMcpRouter.toolDefs.map((t) => t.name));
        }

        fileLog.info(`TOOLS_AVAILABLE | count=${allTools.length} names=${allTools.map((t) => t.name).join(',')}`);
        console.log(chalk.gray(`[CallStore] tools (${allTools.length}): ${allTools.map((t) => t.name).join(', ')}`));

        const bridge = createQwenRealtimeBridge(
            participant,
            {
                apiKey: appConfig.dashscopeApiKey,
                baseUrl: appConfig.dashscopeBaseUrl,
                model: appConfig.realtimeModel,
                voice: profile?.voice ?? appConfig.realtimeVoice ?? 'Ethan',
                instructions,
                vadSilenceDurationMs: appConfig.realtimeVadSilenceDurationMs,
                localTools: allTools,
                greeting,
                speakOnRouteFailure: appConfig.speakOnRouteFailure,
                routeFailureUserReply: profile?.routeFailureUserReply ?? appConfig.routeFailureUserReply,
                fileLog,
            },
            (name, argsJson) => toolExecutor.execute(name, argsJson),
        );

        participantState.set(participant.id, { bridge, fileLog });
        console.log(chalk.green(`[CallStore] bridge started for participant ${participant.id}`));
    };

    const handleParticipantDisconnected = (participantId: number) => {
        const st = participantState.get(participantId);
        st?.fileLog.info('PARTICIPANT_DISCONNECTED');
        console.log(chalk.green(`[CallStore] participant ${participantId} disconnected`));
        cleanup(participantId);
    };

    client.on('participantConnected', handleParticipantConnected);
    client.on('participantDisconnected', handleParticipantDisconnected);

    console.log(chalk.cyan('[CallStore] initialized (Qwen Omni realtime)'));
}
