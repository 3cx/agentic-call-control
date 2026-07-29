export interface AppConfig {
  appId: string;
  appSecret: string;
  pbxBase: string;
  dashscopeApiKey: string;
  dashscopeBaseUrl: string;
  agentProfile?: string;
  agentInstructions?: string;
  companyName?: string;
  agentName?: string;
  initialGreeting: string;
  speakOnRouteFailure: boolean;
  routeFailureUserReply: string;
  /** Realtime model. Default: qwen3.5-omni-plus-realtime */
  realtimeModel?: string;
  /** Fallback voice; agent profile voice takes priority */
  realtimeVoice?: string;
  /** Server VAD silence duration in ms */
  realtimeVadSilenceDurationMs?: number;
  /**
   * Optional extra MCP servers (in addition to 3CX `{pbxBase}/mcp`).
   * See `@3cx-examples/mcp`. Omit or leave empty to use only 3CX MCP.
   */
  customMcpServers?: import('@3cx-examples/mcp').CustomMcpServerConfig[];
}

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';

const DASHSCOPE_DEFAULT_BASE = 'https://dashscope-intl.aliyuncs.com';

function loadConfig(): AppConfig {
    const configPath = resolve(process.cwd(), 'config.yaml');
    const raw = readFileSync(configPath, 'utf-8');
    const cfg = load(raw) as AppConfig;
    cfg.dashscopeBaseUrl ??= DASHSCOPE_DEFAULT_BASE;
    return cfg;
}

export default loadConfig();
