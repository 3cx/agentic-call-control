import type { Participant } from '@3cx/call-control-sdk';
import type { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import chalk from 'chalk';
import { callMcpTool } from '@3cx-examples/mcp';
import type { CustomMcpRouter } from '@3cx-examples/mcp';
import {
    blockIfAvailabilityUnknown,
    blockScreeningBeforeRouteDecision,
    finalizePhonebookResult,
    isRouteNotTransferable,
    availabilityUnknownHint,
} from './call-routing.ts';
import { isExtensionAllowed } from './local-tools.ts';
import type { AgentProfile } from './agent-profiles.ts';
import type { CallState } from './call-state.ts';
import { formatScreening, isScreeningReady, missingScreeningFields } from './call-state.ts';

export interface ToolResult {
    content: string;
    action?: 'transfer' | 'drop' | 'divert' | 'transfer_voicemail';
    destination?: string;
    announcement?: string;
}

export interface ToolExecutorDeps {
    participant: Participant;
    mcpClient?: McpClient;
    mcpToolNames: Set<string>;
    customMcpRouter?: CustomMcpRouter;
    profile: AgentProfile;
    callState: CallState;
    onCleanup: () => void;
}

export function createToolExecutor(deps: ToolExecutorDeps) {
    const { participant, mcpClient, mcpToolNames, customMcpRouter, profile, callState } = deps;

    async function execute(toolName: string, argsJson: string): Promise<ToolResult> {
        const args = safeParse(argsJson);

        switch (toolName) {
        case 'transfer_call': return handleTransferCall(args);
        case 'drop_call': return handleDropCall();
        case 'transfer_to_voicemail': return handleTransferToVoicemail(args);
        case 'update_screening': return handleUpdateScreening(args);
        default:
            if (customMcpRouter?.has(toolName)) {
                return handleCustomMcpTool(toolName, args);
            }
            if (mcpToolNames.has(toolName) && mcpClient) {
                return handleMcpTool(toolName, args);
            }
            return { content: `Unknown tool: ${toolName}` };
        }
    }

    async function handleTransferCall(args: Record<string, unknown>): Promise<ToolResult> {
        const destination = String(args.destination ?? '');
        if (!destination) return { content: 'No destination specified.' };

        if (!isExtensionAllowed(destination, profile)) {
            return { content: `Transfer to ${destination} is not allowed.` };
        }

        if (profile.callScreening && !isScreeningReady(callState.screening)) {
            const missing = missingScreeningFields(callState.screening);
            console.log(chalk.yellow(`[ToolExec] transfer blocked — missing: ${missing.join(', ')}`));
            return { content: `Before transferring, ask the caller for: ${missing.join(', ')}.` };
        }

        const blocked = blockRouteIfAvailabilityUnknown(destination, 'transfer');
        if (blocked) return blocked;

        if (profile.callScreening) await submitScreening();

        const contact = callState.pendingRoute?.extensionNumber === destination
            ? callState.pendingRoute
            : undefined;

        console.log(chalk.magentaBright(`[ToolExec] transfer_call → ${destination}`));

        return {
            content: `Transfer to ${destination} initiated.`,
            action: 'transfer',
            destination,
            announcement: contact?.displayName
                ? `I'll transfer you to ${contact.displayName} now.`
                : "I'll transfer you now.",
        };
    }

    function handleDropCall(): ToolResult {
        console.log(chalk.magentaBright('[ToolExec] drop_call'));
        return { content: 'Call will be ended.', action: 'drop' };
    }

    async function handleTransferToVoicemail(args: Record<string, unknown>): Promise<ToolResult> {
        const destination = String(args.destination ?? '');
        if (!destination) return { content: 'No destination specified.' };

        if (!isExtensionAllowed(destination, profile)) {
            return { content: `Transfer to voicemail of ${destination} is not allowed.` };
        }

        if (profile.callScreening && !isScreeningReady(callState.screening)) {
            const missing = missingScreeningFields(callState.screening);
            console.log(chalk.yellow(`[ToolExec] voicemail blocked — missing: ${missing.join(', ')}`));
            return { content: `Before sending to voicemail, ask the caller for: ${missing.join(', ')}.` };
        }

        const blocked = blockRouteIfAvailabilityUnknown(destination, 'voicemail');
        if (blocked) return blocked;

        if (profile.callScreening) await submitScreening();

        const contact = callState.pendingRoute?.extensionNumber === destination
            ? callState.pendingRoute
            : undefined;

        console.log(chalk.magentaBright(`[ToolExec] transfer_to_voicemail → ${destination}`));

        return {
            content: `Sending to voicemail of ${destination}.`,
            action: 'transfer_voicemail',
            destination,
            announcement: contact?.displayName
                ? `I'll send you to ${contact.displayName}'s voicemail now.`
                : "I'll send you to voicemail now.",
        };
    }

    const SCREENING_FIELDS = new Set(['name', 'company', 'reason']);

    function screeningStatus(): string {
        const s = callState.screening;
        const saved = [
            s.name ? `name="${s.name}"` : null,
            s.company ? `company="${s.company}"` : null,
            s.reason ? `reason="${s.reason}"` : null,
        ].filter(Boolean).join(', ');
        const missing = missingScreeningFields(s);
        if (missing.length === 0) return `Screening complete (${saved}). You may now transfer or send to voicemail.`;
        return `Saved so far: ${saved}. Still need: ${missing.join(', ')}.`;
    }

    function handleUpdateScreening(args: Record<string, unknown>): ToolResult {
        const routeBlocked = blockIfRouteNotTransferable('screening');
        if (routeBlocked) return routeBlocked;

        const screeningBlocked = blockScreeningBeforeRouteDecision(
            callState.pendingRoute,
            profile.checkAvailability ?? false,
        );
        if (screeningBlocked) {
            console.log(chalk.yellow(`[ToolExec] screening blocked — ${screeningBlocked}`));
            return { content: screeningBlocked };
        }

        const field = String(args.field ?? '');
        const value = String(args.value ?? '');
        if (!SCREENING_FIELDS.has(field)) return { content: `Unknown screening field: ${field}` };
        if (!value) return { content: 'No value provided.' };

        (callState.screening as Record<string, string>)[field] = value;
        console.log(chalk.cyan(`[ToolExec] screening.${field} = "${value}"`));
        return { content: `Screening saved: ${field} = ${value}. ${screeningStatus()}` };
    }

    async function submitScreening(): Promise<void> {
        const text = formatScreening(callState.screening);
        try {
            console.log(chalk.cyan(`[ToolExec] attachPartyData: ${text}`));
            await participant.attachPartyData({ public_call_screening: text });
            console.log(chalk.green('[ToolExec] attachPartyData OK'));
        } catch (e) {
            console.error(chalk.red('[ToolExec] attachPartyData error:'), e);
        }
    }

    async function handleCustomMcpTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
        console.log(chalk.cyan(`[CustomMCP] calling "${toolName}"`, JSON.stringify(args)));
        try {
            const result = await customMcpRouter!.callTool(toolName, args);
            console.log(chalk.cyan(`[CustomMCP] "${toolName}" result:`, result.substring(0, 300)));
            return { content: result };
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            console.error(chalk.red(`[CustomMCP] "${toolName}" error:`), msg);
            return { content: `Error calling ${toolName}: ${msg}` };
        }
    }

    async function handleMcpTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
        const mcpArgs = toolName === 'list_phonebook'
            ? {
                ...args,
                searchExtensions: true, // only search extensions
                searchCompany: false,
                searchPersonal: false,
                searchGroup: false,
            }
            : args;

        console.log(chalk.cyan(`[MCP] calling "${toolName}"`, JSON.stringify(mcpArgs)));
        try {
            const result = await callMcpTool(mcpClient!, toolName, mcpArgs);
            console.log(chalk.cyan(`[MCP] "${toolName}" result:`, result.substring(0, 300)));

            if (toolName === 'list_phonebook') {
                const { content, pendingRoute } = finalizePhonebookResult(result, profile.checkAvailability ?? false);
                callState.pendingRoute = pendingRoute;
                if (pendingRoute) {
                    console.log(chalk.cyan(
                        `[ToolExec] pendingRoute ext=${pendingRoute.extensionNumber} `
                        + `isAvailable=${String(pendingRoute.isAvailable)}`,
                    ));
                }
                return { content };
            }

            return { content: result };
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            console.error(chalk.red(`[MCP] "${toolName}" error:`), msg);
            return { content: `Error calling ${toolName}: ${msg}` };
        }
    }

    function blockIfRouteNotTransferable(action: string): ToolResult | null {
        if (!isRouteNotTransferable(callState.pendingRoute, profile.checkAvailability ?? false)) return null;
        const block = availabilityUnknownHint(callState.pendingRoute!);
        console.log(chalk.yellow(`[ToolExec] ${action} blocked — ${block}`));
        return { content: block };
    }

    function blockRouteIfAvailabilityUnknown(destination: string, action: string): ToolResult | null {
        if (!profile.checkAvailability) return null;
        const block = blockIfAvailabilityUnknown(callState.pendingRoute, destination);
        if (!block) return null;
        console.log(chalk.yellow(`[ToolExec] ${action} blocked — ${block}`));
        return { content: block };
    }

    return { execute };
}

function safeParse(json: string): Record<string, unknown> {
    try { return JSON.parse(json || '{}'); }
    catch { return {}; }
}
