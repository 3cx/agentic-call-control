# CLAUDE.md — openai-realtime example

## Commands

```bash
yarn start          # from examples/openai-realtime
yarn build
yarn lint
```

From repo root: `yarn start:openai-realtime`

## Architecture

```
index.ts
  → call-store.ts (per-participant orchestrator)
  → providers/openai-realtime.ts (OpenAI GA Realtime WebSocket)
  → agent/tool-executor.ts (local + MCP tools)
```

## Key files

| File | Role |
|------|------|
| `src/providers/openai-realtime.ts` | OpenAI Realtime WebSocket bridge — audio, events, tool dispatch, playback gate |
| `src/callcontrol/call-store.ts` | Per-call lifecycle, MCP tool wiring |
| `src/agent/tool-executor.ts` | transfer_call, drop_call, transfer_to_voicemail, MCP proxy |
| `agents/receptionist.yaml` | Agent profile (prompt, screening, availability rules) |

## Config

`config.yaml` (gitignored) loaded by `app-config.ts`. Template: `config.yaml.example`.

Required: `openaiApiKey`, `appId`, `appSecret`, `pbxBase`.

## OpenAI Realtime notes

- Uses GA API: nested `session.audio` structure, `session.type: 'realtime'`
- 8 kHz PBX audio upsampled to 24 kHz for OpenAI; output downsampled 3:1
- Greeting via `response.create` with `tool_choice: 'none'`
- Reference implementation: `voice-agent-orchestrator/src/architectures/realtime/openai.ts`
