import type { Participant } from '@3cx/call-control-sdk';
import type { AgentProfile } from './agent-profiles.ts';
import type { CallState } from './call-state.ts';
import type { CallLogger } from '../logging/call-logger.ts';
import type { CustomMcpRouter, McpManager } from '@3cx-examples/mcp';

export interface ToolResult {
    content: string;
    action?: 'transfer' | 'drop' | 'divert' | 'transfer_voicemail';
    destination?: string;
}

export interface ToolDeps {
    participant: Participant;
    mcpManager?: McpManager;
    customMcpRouter?: CustomMcpRouter;
    profile: AgentProfile;
    callState: CallState;
    onCleanup: () => void;
    logger?: CallLogger;
}

export type ToolHandler = (args: Record<string, unknown>, deps: ToolDeps) => Promise<ToolResult>;

export class ToolRegistry {
    private handlers = new Map<string, ToolHandler>();

    register(name: string, handler: ToolHandler): void {
        this.handlers.set(name, handler);
    }

    has(name: string): boolean {
        return this.handlers.has(name);
    }

    list(): string[] {
        return Array.from(this.handlers.keys());
    }

    async execute(name: string, args: Record<string, unknown>, deps: ToolDeps): Promise<ToolResult> {
        const handler = this.handlers.get(name);
        if (!handler) {
            return { content: `Unknown tool: ${name}` };
        }
        return handler(args, deps);
    }
}
