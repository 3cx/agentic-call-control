import type { CustomMcpServerConfig } from '@3cx-examples/mcp';

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
    openaiVoice?: string; // Fallback when agent profile has no voice
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
