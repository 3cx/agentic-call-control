# CLAUDE.md — gemini-realtime example

Google Gemini Live API realtime voice agent (no separate STT/TTS pipeline).

## Commands

```bash
yarn start          # from examples/gemini-realtime
# or from repo root: yarn start:gemini
yarn build
yarn lint
```

## Architecture

An AI voice agent that connects to 3CX PBX via the CallControl SDK and uses **Google Gemini Live** for real-time voice interaction — a single WebSocket handles STT, LLM reasoning, and TTS simultaneously.

- **Voice**: Gemini Live API (`gemini-3.1-flash-live-preview`) — bidirectional audio WebSocket with server-side VAD
- **Audio**: 3CX streams PCM 8 kHz 16-bit mono; upsampled to 16 kHz for Gemini input, Gemini outputs 24 kHz downsampled to 8 kHz for 3CX
- **Agent profiles**: YAML config with Mustache prompt templates in separate `.mustache` files
- **Tools**: local SDK-backed tools (transfer, drop, voicemail, screening) + MCP tools (phonebook, contacts)

### Request Flow

```
3CX CallControl SDK (participant joins)
  → callcontrol/call-store.ts    (orchestrator — creates Gemini bridge per participant)
  → providers/gemini-live.ts     (Gemini Live WebSocket — audio in/out, tool dispatch)
      → agent/tool-executor.ts   (local tools + MCP proxy)
      → agent/call-state.ts      (per-call screening state)
```

### File Structure

```
src/
├── index.ts                       # Entry point — SDK + MCP init
├── app-config.ts                  # Loads config.yaml via js-yaml
│
├── providers/
│   └── gemini-live.ts             # Gemini Live WebSocket bridge — audio, events, tool dispatch
│
├── agent/
│   ├── agent-profiles.ts          # YAML loader + Mustache prompt rendering + policies
│   ├── local-tools.ts             # Tool schemas: transfer, drop, voicemail, screening
│   ├── tool-executor.ts           # Dispatch: local SDK tools + MCP proxy
│   └── call-state.ts              # Per-call state: screening fields, completeness check
│
├── mcp/
│   └── mcp-client.ts              # MCP client: connect, listTools, callTool
│
└── callcontrol/
    ├── call-store.ts              # Orchestrator: creates bridge per participant
    ├── audio-utils.ts             # Upsample 8k→16k, downsample 24k→8k
    └── sentence-accumulator.ts    # Buffers transcript fragments into complete sentences for logging

agents/
└── receptionist.yaml              # Receptionist persona: role, tools, policies, screening config
```

### Key Design Points

- **Config**: all settings live in `config.yaml` in this example directory. Loaded at startup by `src/app-config.ts` using `js-yaml`. The file is gitignored — use `config.yaml.example` as a template.
- **Audio format**: 3CX streams PCM 8 kHz 16-bit mono. Upsampled 2:1 to 16 kHz for Gemini input. Gemini outputs PCM 24 kHz — downsampled 3:1 to 8 kHz via `audio-utils.ts`.
- **VAD**: server-side via Gemini's `automaticActivityDetection` with configurable `silenceDurationMs`.
- **Barge-in**: Gemini sends `interrupted` flag → `audioWriter.clear()` cancels queued TTS audio.
- **Greeting**: after Gemini setup completes, a `clientContent` turn triggers the model to speak the greeting immediately.
- **Agent profiles**: YAML files in `agents/` define role, prompt, greeting, allowed actions, MCP tools, policies, and screening config.
- **Transcript logging**: `SentenceAccumulator` buffers Gemini's incremental transcription fragments and logs complete sentences.
- **ESLint**: flat config (`eslint.config.mjs`) with `typescript-eslint` recommended rules and 4-space indent enforced.
