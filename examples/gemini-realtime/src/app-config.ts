export interface AppConfig {
    appId: string;
    appSecret: string;
    pbxBase: string;

    geminiApiKey: string;
    geminiVoice?: string;
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
    customMcpServers?: import('@3cx-examples/mcp').CustomMcpServerConfig[];
}

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';

function loadConfig(): AppConfig {
    const configPath = resolve(process.cwd(), 'config.yaml');
    const raw = readFileSync(configPath, 'utf-8');
    return load(raw) as AppConfig;
}

export default loadConfig();
