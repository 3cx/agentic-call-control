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
    customMcpServers?: import('@3cx-examples/mcp').CustomMcpServerConfig[];
}

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';

function loadConfig(): AppConfig {
    const configPath = resolve(process.cwd(), 'config.yaml');
    const raw = readFileSync(configPath, 'utf-8');
    const cfg = load(raw) as AppConfig;
    // YAML may parse numeric Client IDs as numbers; SDK compares DN with strict ===.
    if (cfg.appId != null && typeof cfg.appId !== 'string') {
        cfg.appId = String(cfg.appId);
    }
    return cfg;
}

export default loadConfig();
