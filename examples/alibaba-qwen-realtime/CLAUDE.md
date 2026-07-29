# CLAUDE.md — alibaba-qwen-realtime example

Alibaba Cloud DashScope Qwen Omni Realtime — end-to-end voice conversation over a single WebSocket. No separate STT/LLM/TTS pipeline.

## Commands

```bash
yarn start          # from examples/alibaba-qwen-realtime (runs via tsx)
# or from repo root: yarn start:alibaba-qwen
yarn build          # Type-check only (tsc --noEmit)
yarn lint
```

## Architecture

```
3CX CallControlClient
  → callcontrol/call-store.ts (orchestrator)
  → providers/qwen-realtime.ts (DashScope WebSocket)
      ↔ audio: 8k → upsample 16k → model → 24k → downsample 8k
      ↔ tools: agent/tool-executor.ts (local + MCP tools)
```

Single WebSocket handles audio I/O, conversation, and tool calls. Barge-in is server-side (no client VAD). MCP tools fetched at startup, merged with local tools.

### Request Flow

```
participantConnected
  → call-store.ts wires Qwen bridge + tool executor
  → qwen-realtime.ts opens WebSocket, sends session update (instructions, tools, voice)
  → audio stream: 3CX 8k PCM → upsample 2:1 → Qwen 16k in | 24k out → downsample 3:1 → 3CX 8k
  → tool calls: model → tool-executor.ts → local/MCP handler → result → model
  → routing: transfer/voicemail/drop wait for audio drain, then SDK call
```

### File Structure

```
src/
├── index.ts                          # Entry: SDK client, MCP manager, call-store init
├── app-config.ts                     # Loads config.yaml (js-yaml)
├── callcontrol/call-store.ts         # Per-call orchestrator
├── providers/qwen-realtime.ts        # DashScope WebSocket: audio I/O, tool calls, session mgmt
├── agent/
│   ├── agent-profiles.ts             # YAML loader + prompt rendering (mustache placeholders)
│   ├── call-state.ts                 # Screening state (name, company, reason)
│   ├── local-tools.ts                # Local tool defs (transfer, drop, voicemail, screening)
│   ├── tool-executor.ts              # Executes local + MCP tools, enforces screening guards
│   └── tool-registry.ts              # Merges local + MCP tools → Qwen format
├── mcp/
│   ├── mcp-client.ts                 # MCP server HTTP connection
│   └── mcp-manager.ts                # Tool discovery + DashScope schema conversion
└── logging/call-logger.ts            # Per-call JSONL logs
```

## Key Design Points

- **Config**: `config.yaml` (gitignored) loaded by `app-config.ts`. Template: `config.yaml.example`. Required: `dashscopeApiKey`, `dashscopeBaseUrl`, `realtimeModel`, `realtimeVoice`. Optional: `realtimeVadSilenceDurationMs`, `agentProfile` or `agentInstructions`.
- **Audio**: 3CX 8 kHz PCM in/out. Qwen needs 16 kHz in, outputs 24 kHz. `qwen-realtime.ts` upsamples 8k→16k (duplicate samples), downsamples 24k→8k (3:1 decimation).
- **WebSocket session**: One DashScope Realtime WebSocket per call. Session update sent on connect with instructions, tools, voice, VAD. Barge-in handled server-side.
- **Tool calls**: DashScope sends `{ type: 'function_call', callId, name, arguments }`. `qwen-realtime.ts` parses, invokes `tool-executor.ts`, sends result back. Model can chain multiple calls.
- **Screening guards**: `tool-executor.ts` blocks transfer/voicemail until screening complete (if `callScreening: true` in profile). Missing fields return error to model.
- **MCP integration**: `mcp-manager.ts` fetches tools from 3CX MCP server at startup, converts to DashScope format, merges with local tools. Runtime calls via HTTP POST.
- **Agent profiles**: `agents/<name>.yaml` with mustache placeholders (`{{company_name}}`, `{{agent_name}}`, `{{caller_name}}`, `{{caller_number}}`). Profile `voice` overrides config fallback.
- **Audio drain**: transfer/drop/voicemail wait for current audio response to finish before executing SDK call, then stop bridge.

## Config Highlights

| Field | Notes |
|-------|-------|
| `dashscopeBaseUrl` | `https://dashscope-intl.aliyuncs.com` (Singapore) or `https://dashscope.aliyuncs.com` (mainland China) — API keys are region-locked; use the URL matching where your key was created |
| `realtimeModel` | `qwen3.5-omni-plus-realtime` (reliable tool calls) or `qwen3.5-omni-flash-realtime` (cheaper, may vocalize tools) |
| `realtimeVoice` | Fallback voice; profile `voice` overrides |
| `realtimeVadSilenceDurationMs` | Server VAD silence threshold (optional, model default if omitted) |
| `agentProfile` | Loads `agents/<name>.yaml`. Mutually exclusive with `agentInstructions`. |
| `speakOnRouteFailure` | Speak `routeFailureUserReply` on transfer failure |
| `saveAudioToFile` / `audioOutputDir` | Save caller audio as WAV for debugging |

## Tool Execution

1. Model calls tool → DashScope sends `function_call` message
2. `qwen-realtime.ts` parses, logs, invokes `tool-executor.ts`
3. Executor routes: local (transfer/drop/screening) or MCP (phonebook)
4. Result returned → sent as `function_call_result` to DashScope
5. Model incorporates result, continues conversation

**Screening guard**: if `callScreening: true` and fields incomplete, transfer blocked with error result. After `update_screening` completes all fields, session update sent to refresh instructions.

## Logging

- **Console**: blue (WebSocket), green (participant), yellow (tools/cleanup), red (errors), magenta (tool results)
- **File**: `audioOutputDir/call-{id}-{ts}.jsonl` — per-call event log (call_start, user_speech, assistant_speech, tool_call, call_end)

## Troubleshooting

- **WebSocket fails**: check `dashscopeApiKey` (starts with `sk-`), `dashscopeBaseUrl` matches region, network connectivity
- **Model vocalizes tool calls**: switch to `qwen3.5-omni-plus-realtime`, clarify tool descriptions
- **Transfer blocked**: ensure `update_screening` called with all fields (`name`, `company`, `reason`)
- **Choppy audio**: check CPU usage (real-time resampling), verify 3CX stream stable
- **MCP tools not used**: verify MCP manager connected (startup log), tools listed in session update, clear descriptions in instructions
