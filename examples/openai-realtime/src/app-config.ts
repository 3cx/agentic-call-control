export interface VoiceBehaviorConfig {
    firstUtteranceDelayMs?: number;
    silenceThreshold?: number;
}

export interface AppConfig {
    appId: string;
    appSecret: string;
    pbxBase: string;

    openaiApiKey: string;
    openaiModel?: string;
    openaiVoice?: string;
    openaiVadSilenceDurationMs?: number;
    openaiVadThreshold?: number;
    openaiInputTranscriptionModel?: string;
    /** Optional BCP-47 language hint (e.g. en) — improves caller transcript accuracy. */
    openaiInputTranscriptionLanguage?: string;

    agentProfile?: string;
    agentInstructions?: string;
    companyName?: string;
    agentName?: string;
    initialGreeting: string;

    voiceBehavior?: VoiceBehaviorConfig;
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
