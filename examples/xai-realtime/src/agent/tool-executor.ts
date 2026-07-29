import type { Participant } from '@3cx/call-control-sdk';
import type { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import chalk from 'chalk';
import { callMcpTool } from '@3cx-examples/mcp';
import type { CustomMcpRouter } from '@3cx-examples/mcp';
import {
    blockIfAvailabilityUnknown,
    enrichPhonebookResult,
    isRouteNotTransferable,
    availabilityUnknownHint,
    parsePhonebookContacts,
} from './call-routing.ts';
import { isExtensionAllowed } from './local-tools.ts';
import type { AgentProfile } from './agent-profiles.ts';
import type { CallState } from './call-state.ts';
import { formatScreening, isScreeningReady, missingScreeningFields } from './call-state.ts';
import type { CallLogger } from '@3cx-examples/logger';

export interface ToolResult {
    content: string;
    action?: 'connect' | 'drop' | 'voicemail';
    destination?: string;
}

export interface ToolExecutorDeps {
    participant: Participant;
    mcpClient?: McpClient;
    mcpToolNames: Set<string>;
    customMcpRouter?: CustomMcpRouter;
    profile: AgentProfile;
    callState: CallState;
    onCleanup: () => void;
    logger?: CallLogger;
}

export function createToolExecutor(deps: ToolExecutorDeps) {
    const { participant, mcpClient, mcpToolNames, customMcpRouter, profile, callState, logger } = deps;
    const log = logger ?? null;

    async function execute(toolName: string, argsJson: string): Promise<ToolResult> {
        const args = safeParse(argsJson);

        switch (toolName) {
        case 'transfer_call': return handleConnect(args);
        case 'leave_voicemail':   return handleVoicemail(args);
        case 'end_call':          return handleEndCall();
        case 'update_screening':  return handleUpdateScreening(args);
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

    async function handleConnect(args: Record<string, unknown>): Promise<ToolResult> {
        const destination = String(args.extension_number ?? '');
        if (!destination) return { content: 'No extension specified.' };
        if (!/^\d+$/.test(destination)) {
            return { content: `"${destination}" is not a valid extension number. Use extension_number from search results.` };
        }
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
        return commitRoute({ content: `Connecting caller to ${destination}.`, action: 'connect', destination });
    }

    async function handleVoicemail(args: Record<string, unknown>): Promise<ToolResult> {
        const destination = String(args.extension_number ?? '');
        if (!destination) return { content: 'No extension specified.' };
        if (!/^\d+$/.test(destination)) {
            return { content: `"${destination}" is not a valid extension number.` };
        }
        if (!isExtensionAllowed(destination, profile)) {
            return { content: `Voicemail for ${destination} is not allowed.` };
        }

        if (profile.callScreening && !isScreeningReady(callState.screening)) {
            const missing = missingScreeningFields(callState.screening);
            console.log(chalk.yellow(`[ToolExec] voicemail blocked — missing: ${missing.join(', ')}`));
            return { content: `Before sending to voicemail, ask the caller for: ${missing.join(', ')}.` };
        }

        const blocked = blockRouteIfAvailabilityUnknown(destination, 'voicemail');
        if (blocked) return blocked;

        if (profile.callScreening) await submitScreening();
        return commitRoute({ content: `Sending caller to voicemail of ${destination}.`, action: 'voicemail', destination });
    }

    function handleEndCall(): ToolResult {
        log?.info('END_CALL_REQUESTED');
        console.log(chalk.magentaBright('[ToolExec] end_call'));
        return commitRoute({ content: 'Ending call.', action: 'drop' });
    }

    const SCREENING_FIELDS = new Set(['name', 'company', 'reason']);

    function handleUpdateScreening(args: Record<string, unknown>): ToolResult {
        const routeBlocked = blockIfRouteNotTransferable('screening');
        if (routeBlocked) return routeBlocked;

        const field = String(args.field ?? '');
        const value = String(args.value ?? '');
        if (!SCREENING_FIELDS.has(field)) return { content: `Unknown screening field: ${field}` };
        if (!value) return { content: 'No value provided.' };

        (callState.screening as Record<string, string>)[field] = value;
        console.log(chalk.cyan(`[ToolExec] screening.${field} = "${value}"`));
        if (field === 'name') {
            return { content: `Caller identified as ${value}.` };
        }
        return { content: `Screening updated: ${field} = ${value}` };
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
            log?.error(`CUSTOM_MCP_ERROR | tool=${toolName} error="${msg}"`);
            console.error(chalk.red(`[CustomMCP] "${toolName}" error:`), msg);
            return { content: `Error calling ${toolName}: ${msg}` };
        }
    }

    async function handleMcpTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
        const mcpArgs = toolName === 'list_phonebook'
            ? {
                ...args,
                searchExtensions: true,
                searchCompany: false,
                searchPersonal: false,
                searchGroup: false,
            }
            : args;

        log?.info(`MCP_CALL | tool=${toolName} args=${JSON.stringify(mcpArgs)}`);
        console.log(chalk.cyan(`[MCP] calling "${toolName}"`, JSON.stringify(mcpArgs)));
        try {
            const result = await callMcpTool(mcpClient!, toolName, mcpArgs);
            log?.info(`MCP_RESULT | tool=${toolName} bytes=${result.length} preview="${result.substring(0, 300)}"`);
            console.log(chalk.cyan(`[MCP] "${toolName}" result:`, result.substring(0, 300)));

            if (toolName === 'list_phonebook') {
                const contacts = parsePhonebookContacts(result);

                if (contacts.length === 1) {
                    callState.pendingRoute = contacts[0];
                    log?.info(`PHONEBOOK_PENDING_ROUTE | ext=${contacts[0].extensionNumber} name="${contacts[0].displayName}" available=${String(contacts[0].isAvailable)}`);
                } else {
                    callState.pendingRoute = undefined;
                }

                return { content: enrichPhonebookResult(result, contacts) };
            }

            return { content: result };
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            log?.error(`MCP_ERROR | tool=${toolName} error="${msg}"`);
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
        log?.info(`ROUTE_BLOCKED | destination=${destination} reason=availability_unknown`);
        console.log(chalk.yellow(`[ToolExec] ${action} blocked — ${block}`));
        return { content: block };
    }

    function commitRoute(result: ToolResult): ToolResult {
        callState.routeCommitted = true;
        if (result.action && result.action !== 'drop') {
            log?.info(`ROUTE_COMMITTED | action=${result.action} destination=${result.destination}`);
            console.log(chalk.magentaBright(`[ToolExec] ${result.action} → ${result.destination}`));
        } else if (result.action === 'drop') {
            log?.info('ROUTE_COMMITTED | action=drop');
        }
        return result;
    }

    return { execute };
}

function safeParse(json: string): Record<string, unknown> {
    try { return JSON.parse(json || '{}'); }
    catch { return {}; }
}
