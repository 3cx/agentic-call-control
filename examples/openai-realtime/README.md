# Agentic Call Control — `openai-realtime`

This example uses the **OpenAI Realtime API** (GA) — a single WebSocket connection that handles speech recognition, LLM reasoning, and speech synthesis simultaneously.

---

## Prerequisites

### 3CX Service Principal

Create API credentials so the agent can control calls on your PBX:

1. Open your 3CX Web Client
2. Go to **Admin → Integrations → API**
3. Click **Add Service Principal**
4. Set a **Client ID** (e.g. `assistant`) — this becomes your `appId`
5. Enable **"Enable access to the 3CX Call Control API for this application"**
6. *(Optional)* Assign a **DID Number**
7. *(Optional)* Click **Select Extensions** to choose which extensions the agent can control
8. **Save** — the generated Client Secret becomes your `appSecret`

### OpenAI API Key

Get an API key from [OpenAI API Keys](https://platform.openai.com/api-keys) with access to the Realtime API (`gpt-realtime-2` or later).

---

## Quick Start

From the **repo root**:

```bash
yarn install
cp examples/openai-realtime/config.yaml.example examples/openai-realtime/config.yaml
```

Edit `examples/openai-realtime/config.yaml`:

```yaml
appId: your-3cx-app-id
appSecret: your-3cx-app-secret
pbxBase: https://your-pbx.3cx.eu:5001

openaiApiKey: sk-your-openai-api-key
# openaiModel: gpt-realtime-2
# openaiVoice: alloy

agentProfile: receptionist
companyName: Your Company
agentName: Assistant
```

Start the example:

```bash
yarn start:openai
```

### Calling the Agent

- **Internal call** — dial the Service Principal **Client ID** (`appId`) from any 3CX extension.
- **External call (DID)** — if you assigned a DID to the Service Principal, callers can dial that number.

Agent behavior is configured via `agentProfile` — see [Agent profiles](../../README.md#agent-profiles) in the root README.

---

## Architecture

```
Incoming call on 3CX
  └─ WebSocket event → call-store.ts (orchestrator)
       └─ openai-realtime.ts → OpenAI Realtime API WebSocket (gpt-realtime-2)
            ├─ audio 8 kHz → upsample 24 kHz → model input
            ├─ model output 24 kHz → downsample 8 kHz → caller audio
            ├─ tool calls → tool-executor.ts → local tools + MCP
            └─ transfer / voicemail / drop via Call Control SDK
```

### OpenAI Realtime specifics

| Aspect | Detail |
|--------|--------|
| Session | `session.type: 'realtime'` with nested `session.audio.{input,output}` |
| Audio | PBX 8 kHz ↔ OpenAI 24 kHz PCM16 |
| Tools | Flat `{ type, name, description, parameters }` schema |
| Greeting | `response.create` with `tool_choice: 'none'` on connect |
| Barge-in | `response.cancel` on `input_audio_buffer.speech_started` |

---

## Configuration

| Key | Description |
|-----|-------------|
| `openaiApiKey` | OpenAI API key |
| `openaiModel` | Realtime model (default: `gpt-realtime-2`) |
| `openaiVoice` | Voice name (default: `alloy`) |
| `openaiVadSilenceDurationMs` | Server VAD silence duration |
| `openaiVadThreshold` | Server VAD threshold |
| `openaiInputTranscriptionModel` | Caller transcript model (default: `gpt-4o-transcribe`; use `none` to disable) |
| `openaiInputTranscriptionLanguage` | Optional language hint (`en`, etc.) |
| `voiceBehavior.silenceThreshold` | Mic noise gate (peak amplitude, default 1500) |
| `voiceBehavior.firstUtteranceDelayMs` | Delay before greeting (default 400 ms) |
| `customMcpServers` | Optional extra MCP servers (beyond 3CX). Enable tools in `agents/<profile>.yaml` `mcpTools` by exact name |

Enable MCP / custom tools per agent in `agents/<profile>.yaml` — list each tool under `mcpTools` (e.g. `list_phonebook`, `googlecalendar.quick_add`).

---

<sub>Part of the <a href="../../README.md">Agentic Call Control</a> examples · Built with <a href="https://www.3cx.com">3CX</a> Call Control SDK</sub>
