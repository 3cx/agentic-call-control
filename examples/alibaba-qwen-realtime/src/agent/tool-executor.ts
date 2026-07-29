import type { Participant } from '@3cx/call-control-sdk';
import chalk from 'chalk';
import { availabilityUnknownHint, blockIfAvailabilityUnknown, finalizePhonebookResult, isRouteNotTransferable } from './call-routing.ts';
import { isExtensionAllowed } from './local-tools.ts';
import type { AgentProfile } from './agent-profiles.ts';
import type { CallState } from './call-state.ts';
import { formatScreening, isScreeningReady, missingScreeningFields } from './call-state.ts';
import type { CallLogger } from '../logging/call-logger.ts';
import type { CustomMcpRouter, McpManager } from '@3cx-examples/mcp';
import { ToolRegistry } from './tool-registry.ts';
import type { ToolResult, ToolDeps, ToolHandler } from './tool-registry.ts';

export type { ToolResult };

export interface ToolExecutorDeps {
    participant: Participant;
    mcpManager?: McpManager;
    customMcpRouter?: CustomMcpRouter;
    profile: AgentProfile;
    callState: CallState;
    onCleanup: () => void;
    logger?: CallLogger;
}

async function submitScreening(participant: Participant, callState: CallState): Promise<void> {
    const text = formatScreening(callState.screening);
    try {
        console.log(chalk.cyan(`[ToolExec] attachPartyData: ${text}`));
        await participant.attachPartyData({ public_call_screening: text });
        console.log(chalk.green(`[ToolExec] attachPartyData OK`));
    } catch (e) {
        console.error(chalk.red('[ToolExec] attachPartyData error:'), e);
    }
}

const handleTransferCall: ToolHandler = async (args, deps) => {
    const destination = String(args.destination ?? '');
    if (!destination) return { content: 'No destination specified.' };

    const routeBlocked = blockIfRouteNotTransferable(deps, 'transfer');
    if (routeBlocked) return routeBlocked;

    if (!/^\d+$/.test(destination)) {
        console.log(chalk.yellow(`[ToolExec] transfer_call rejected — "${destination}" is not an extension number`));
        return { content: `"${destination}" is not a valid extension number. Use the extensionNumber from list_phonebook result.` };
    }

    if (!isExtensionAllowed(destination, deps.profile)) {
        return { content: `Transfer to ${destination} is not allowed.` };
    }

    if (deps.profile.callScreening && !isScreeningReady(deps.callState.screening)) {
        const missing = missingScreeningFields(deps.callState.screening);
        console.log(chalk.yellow(`[ToolExec] transfer blocked — missing: ${missing.join(', ')}`));
        return { content: `Before transferring, ask the caller for: ${missing.join(', ')}.` };
    }

    const blocked = blockRouteIfAvailabilityUnknown(deps, destination, 'transfer');
    if (blocked) return blocked;

    if (deps.profile.callScreening) await submitScreening(deps.participant, deps.callState);
    console.log(chalk.magentaBright(`[ToolExec] transfer_call → ${destination}`));
    return { content: `Transfer to ${destination} initiated.`, action: 'transfer', destination };
};

const handleDropCall: ToolHandler = async () => {
    console.log(chalk.magentaBright('[ToolExec] drop_call'));
    return { content: 'Call will be ended.', action: 'drop' };
};

const handleTransferToVoicemail: ToolHandler = async (args, deps) => {
    const destination = String(args.destination ?? '');
    if (!destination) return { content: 'No destination specified.' };

    const routeBlocked = blockIfRouteNotTransferable(deps, 'voicemail');
    if (routeBlocked) return routeBlocked;

    if (!/^\d+$/.test(destination)) {
        console.log(chalk.yellow(`[ToolExec] transfer_to_voicemail rejected — "${destination}" is not an extension number`));
        return { content: `"${destination}" is not a valid extension number. Use the extensionNumber from the contact result.` };
    }

    if (!isExtensionAllowed(destination, deps.profile)) {
        return { content: `Transfer to voicemail of ${destination} is not allowed.` };
    }

    if (deps.profile.callScreening && !isScreeningReady(deps.callState.screening)) {
        const missing = missingScreeningFields(deps.callState.screening);
        console.log(chalk.yellow(`[ToolExec] voicemail blocked — missing: ${missing.join(', ')}`));
        return { content: `Before sending to voicemail, ask the caller for: ${missing.join(', ')}.` };
    }

    const blocked = blockRouteIfAvailabilityUnknown(deps, destination, 'voicemail');
    if (blocked) return blocked;

    if (deps.profile.callScreening) await submitScreening(deps.participant, deps.callState);
    console.log(chalk.magentaBright(`[ToolExec] transfer_to_voicemail → ${destination}`));
    return { content: `Sending to voicemail of ${destination}.`, action: 'transfer_voicemail', destination };
};

function screeningStatus(s: CallState['screening']): string {
    const saved = [
        s.name ? `name="${s.name}"` : null,
        s.company ? `company="${s.company}"` : null,
        s.reason ? `reason="${s.reason}"` : null,
    ].filter(Boolean).join(', ');
    const missing = missingScreeningFields(s);
    if (missing.length === 0) return `Screening complete (${saved}). You may now transfer or send to voicemail.`;
    return `Saved so far: ${saved}. Still need: ${missing.join(', ')}.`;
}

const handleSaveCallerName: ToolHandler = async (args, deps) => {
    const routeBlocked = blockIfRouteNotTransferable(deps, 'screening');
    if (routeBlocked) return routeBlocked;

    const name = String(args.name ?? '');
    if (!name) return { content: 'No name provided.' };
    deps.callState.screening.name = name;
    console.log(chalk.cyan(`[ToolExec] screening.name = "${name}"`));
    return { content: `Caller name saved: ${name}. ${screeningStatus(deps.callState.screening)}` };
};

const handleSaveCallerCompany: ToolHandler = async (args, deps) => {
    const routeBlocked = blockIfRouteNotTransferable(deps, 'screening');
    if (routeBlocked) return routeBlocked;

    const company = String(args.company ?? '');
    if (!company) return { content: 'No company provided.' };
    deps.callState.screening.company = company;
    console.log(chalk.cyan(`[ToolExec] screening.company = "${company}"`));
    return { content: `Company saved: ${company}. ${screeningStatus(deps.callState.screening)}` };
};

const handleSaveCallerReason: ToolHandler = async (args, deps) => {
    const routeBlocked = blockIfRouteNotTransferable(deps, 'screening');
    if (routeBlocked) return routeBlocked;

    const reason = String(args.reason ?? '');
    if (!reason) return { content: 'No reason provided.' };
    deps.callState.screening.reason = reason;
    console.log(chalk.cyan(`[ToolExec] screening.reason = "${reason}"`));
    return { content: `Reason saved: ${reason}. ${screeningStatus(deps.callState.screening)}` };
};

function blockIfRouteNotTransferable(deps: ToolDeps, action: string): ToolResult | null {
    const route = deps.callState.pendingRoute;
    if (!isRouteNotTransferable(route, deps.profile.checkAvailability ?? false)) return null;
    const block = availabilityUnknownHint(route);
    console.log(chalk.yellow(`[ToolExec] ${action} blocked — ${block}`));
    return { content: block };
}

function blockRouteIfAvailabilityUnknown(deps: ToolDeps, destination: string, action: string): ToolResult | null {
    if (!deps.profile.checkAvailability) return null;
    const block = blockIfAvailabilityUnknown(deps.callState.pendingRoute, destination);
    if (!block) return null;
    console.log(chalk.yellow(`[ToolExec] ${action} blocked — ${block}`));
    return { content: block };
}

function createMcpHandler(toolName: string): ToolHandler {
    return async (args, deps) => {
        if (!deps.mcpManager) return { content: `MCP not available for ${toolName}.` };

        const mcpArgs = toolName === 'list_phonebook'
            ? {
                ...args,
                searchExtensions: true,
                searchCompany: false,
                searchPersonal: false,
                searchGroup: false,
            }
            : args;

        console.log(chalk.cyan(`[MCP] calling tool "${toolName}"`, JSON.stringify(mcpArgs)));
        try {
            const result = await deps.mcpManager.callTool(toolName, mcpArgs);
            console.log(chalk.cyan(`[MCP] tool "${toolName}" result:`, result.substring(0, 300)));

            if (toolName === 'list_phonebook') {
                const { content, pendingRoute } = finalizePhonebookResult(result, deps.profile.checkAvailability ?? false);
                deps.callState.pendingRoute = pendingRoute;
                if (pendingRoute && isRouteNotTransferable(pendingRoute, deps.profile.checkAvailability ?? false)) {
                    console.log(chalk.yellow(`[ToolExec] phonebook — ${pendingRoute.displayName} not transferable (no presence)`));
                }
                return { content };
            }

            return { content: result };
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            console.error(chalk.red(`[MCP] tool "${toolName}" error:`), msg);
            return { content: `Error calling ${toolName}: ${msg}` };
        }
    };
}

function createCustomMcpHandler(toolName: string): ToolHandler {
    return async (args, deps) => {
        if (!deps.customMcpRouter?.has(toolName)) {
            return { content: `Custom MCP tool "${toolName}" not available.` };
        }
        console.log(chalk.cyan(`[CustomMCP] calling "${toolName}"`, JSON.stringify(args)));
        try {
            const result = await deps.customMcpRouter.callTool(toolName, args);
            console.log(chalk.cyan(`[CustomMCP] "${toolName}" result:`, result.substring(0, 300)));
            return { content: result };
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            console.error(chalk.red(`[CustomMCP] "${toolName}" error:`), msg);
            return { content: `Error calling ${toolName}: ${msg}` };
        }
    };
}

function registerBuiltinTools(registry: ToolRegistry): void {
    registry.register('transfer_call', handleTransferCall);
    registry.register('drop_call', handleDropCall);
    registry.register('transfer_to_voicemail', handleTransferToVoicemail);
    registry.register('save_caller_name', handleSaveCallerName);
    registry.register('save_caller_company', handleSaveCallerCompany);
    registry.register('save_caller_reason', handleSaveCallerReason);
}

export function createToolExecutor(deps: ToolExecutorDeps) {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const toolDeps: ToolDeps = deps;

    function setMcpToolNames(names: string[]) {
        for (const name of names) {
            if (!registry.has(name)) {
                registry.register(name, createMcpHandler(name));
            }
        }
    }

    function setCustomMcpToolNames(names: string[]) {
        for (const name of names) {
            if (!registry.has(name)) {
                registry.register(name, createCustomMcpHandler(name));
            }
        }
    }

    async function execute(toolName: string, argsJson: string): Promise<ToolResult> {
        const toolStart = Date.now();
        const args = safeParse(argsJson);
        const result = await registry.execute(toolName, args, toolDeps);
        deps.logger?.toolCall(0, toolName, Date.now() - toolStart);
        return result;
    }

    return { execute, setMcpToolNames, setCustomMcpToolNames, registry };
}

function safeParse(json: string): Record<string, unknown> {
    try { return JSON.parse(json || '{}'); }
    catch { return {}; }
}
