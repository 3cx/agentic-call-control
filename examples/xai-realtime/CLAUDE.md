# CLAUDE.md — xai-realtime example

xAI Grok Voice Agent via realtime WebSocket (no separate STT/TTS pipeline).

## Commands

```bash
yarn start          # from examples/xai-realtime
# or from repo root: yarn start:xai
yarn build
yarn lint
```

## Architecture

```
3CX CallControlClient
  → callcontrol/call-store.ts
  → providers/xai-realtime.ts (xAI Grok realtime WebSocket)
  → agent/tool-executor.ts (local + MCP tools)
  → agent/call-routing.ts (Grok-specific enrichments for tool results)
```

Audio: 3CX 8 kHz PCM passed directly to xAI at 8 kHz — no resampling needed. xAI outputs 8 kHz PCM back to 3CX.

### File Structure

```
src/
├── index.ts                       # Entry point — SDK + MCP init
├── app-config.ts                  # Loads config.yaml via js-yaml
│
├── providers/
│   └── xai-realtime.ts            # xAI Grok realtime WebSocket bridge — audio, events, tool dispatch
│
├── agent/
│   ├── agent-profiles.ts          # YAML loader + prompt rendering + policies
│   ├── local-tools.ts             # Tool schemas: transfer, drop, voicemail, screening
│   ├── tool-executor.ts           # Dispatch: local SDK tools + MCP proxy
│   ├── call-state.ts              # Per-call state: screening fields, completeness check
│   └── call-routing.ts            # Grok-specific enrichments: injects routing rules into tool results
│
├── mcp/
│   └── mcp-client.ts              # MCP client: connect, listTools, callTool
│
└── callcontrol/
    └── call-store.ts              # Orchestrator: creates bridge per participant

agents/
└── receptionist.yaml              # Receptionist persona: role, tools, policies, screening config
```

### Key Design Points

- **Config**: all settings live in `config.yaml` in this example directory. Loaded at startup by `src/app-config.ts` using `js-yaml`. The file is gitignored — use `config.yaml.example` as a template.
- **Audio format**: 3CX streams PCM 8 kHz 16-bit mono. xAI accepts 8 kHz PCM directly — no resampling required.
- **VAD**: server-side via xAI's built-in voice activity detection (`input_audio_buffer.speech_started` / `speech_stopped` events).
- **Barge-in**: xAI sends `speech_started` → `audioWriter.clear()` cancels queued TTS audio.
- **Grok tool-calling workaround**: Grok tends to announce actions in speech without invoking tools. `call-routing.ts` injects explicit routing rules into MCP tool results as structured data to improve compliance.
- **Agent profiles**: YAML files in `agents/` define role, allowed actions, MCP tools, policies, and screening config.
- **ESLint**: flat config (`eslint.config.mjs`) with `typescript-eslint` recommended rules and 4-space indent enforced.
