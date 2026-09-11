import type { CustomMcpServerConfig } from '@3cx-examples/mcp';

export interface AppConfig {
    appId: string;
    appSecret: string;
    pbxBase: string;

    geminiApiKey: string;
    geminiVoice?: string; // Fallback when agent profile has no voice
    geminiModel?: string;
    geminiSilenceDurationMs?: number;

    agentProfile?: string;
    agentInstructions?: string;
    companyName?: string;
    agentName?: string;
    initialGreeting: string;

    speakOnRouteFailure: boolean;
    routeFailureUserReply: string;

    /**
     * Optional extra MCP servers (in addition to 3CX `{pbxBase}/mcp`).
     * See `@3cx-examples/mcp`. Omit or leave empty to use only 3CX MCP.
     */
    customMcpServers?: CustomMcpServerConfig[];
}

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';

export const CONFIG_PATH = resolve(process.cwd(), 'config.yaml');

function loadConfig(): AppConfig {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return load(raw) as AppConfig;
}

export default loadConfig();
