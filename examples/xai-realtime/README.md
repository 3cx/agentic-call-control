# Agentic Call Control — `cloud/xai-realtime`

This branch uses the **xAI Grok Voice Agent API** — a single WebSocket connection that handles speech recognition, LLM reasoning, and speech synthesis simultaneously.

---

## Prerequisites

### 3CX Service Principal

Create API credentials so the agent can control calls on your PBX:

1. Open your 3CX Admin Console
2. Go to **Admin → Integrations → API**
3. Click **Add Service Principal**
4. Set a **Client ID** (e.g. `assistant`) — this becomes your `appId`
5. Enable **"Enable access to the 3CX Call Control API for this application"**
6. Assign a **DID Number** (the phone number callers will dial)
7. Click **Select Extensions** to choose which extensions the agent can control
8. **Save** — the generated Client Secret becomes your `appSecret`

### xAI API Key

Get an API key from the [xAI Console](https://console.x.ai).

---

## Quick Start

```bash
yarn install
cp config.yaml.example config.yaml
# ⚠️ Edit config.yaml with your credentials before starting (see table below)
yarn start
```

### Credentials

Open `config.yaml` and replace the placeholder values:

| Field | Where to get it |
|---|---|
| `appId` | 3CX Management Console → Voice Apps → your app's Client ID |
| `appSecret` | 3CX Management Console → Voice Apps → your app's Client Secret |
| `pbxBase` | Your 3CX PBX URL (e.g. `https://your-pbx.3cx.eu:5001`) |
| `xaiApiKey` | [xAI Console](https://console.x.ai) |

---

## Architecture

```
Incoming call on 3CX
  └─ WebSocket event → call-store.ts (orchestrator)
       └─ xai-realtime.ts → xAI Grok Realtime WebSocket (grok-3-fast)
            ├─ audio 8 kHz PCM → model input (native 8 kHz)
            ├─ tool calls → tool-executor
            │                ├─ local tools (transfer/voicemail/drop/screening) → routing
            │                └─ MCP tools (phonebook/contacts) → data lookup
            └─ model output → 8 kHz PCM → caller hears audio
```

No separate STT, LLM, or TTS pipeline — the realtime model handles conversation audio end-to-end.

---

## Tools

### Local Tools (SDK-backed)

xAI calls these as function tools. The app executes them via the 3CX SDK.

| Tool | What it does | Behavior |
|---|---|---|
| `transfer_call` | `participant.transfer(ext)` | Waits for audio drain, then transfers. Blocked if screening incomplete. |
| `drop_call` | `participant.drop()` | Waits for audio drain (caller hears goodbye), then drops. No extra `response.create`. |
| `transfer_to_voicemail` | `participant.transferToVoiceMail(ext)` | Same guards as transfer |
| `update_screening` | Saves `name`, `company`, or `reason` | **Silent** — no `response.create` after, preventing speech repetition |

### MCP Tools (PBX Server)

Fetched from 3CX MCP at startup, converted to xAI function tool format, proxied locally.

| Tool | What it does |
|---|---|
| `list_phonebook` | Search PBX phonebook by name, extension, or email. Returns `isAvailable`. |

Enable tools per agent in `agents/<profile>.yaml` via `mcpTools` (exact names). Optional extra MCP servers: `customMcpServers` in `config.yaml.example` — after connecting, add each tool name to the same `mcpTools` list.

### Tool Results

After tool execution the bridge always sends `response.create` so the model can continue the turn (unless a call action like transfer or drop is pending).

<br>

---

<br>

## Key Implementation Details

### WebSocket Connection

```
wss://api.x.ai/v1/realtime?model=grok-3-fast
Authorization: Bearer <API_KEY>
```

### Session Configuration

On connect, `session.update` configures:
- **voice** — from config (`tara`, `nova`, etc.)
- **instructions** — rendered from agent profile (Mustache template)
- **tools** — merged local + MCP function definitions
- **turn_detection** — `server_vad` with configurable `silence_duration_ms`
- **audio format** — `audio/pcm` at `rate: 8000` (input and output)

### Greeting

Sent as `conversation.item.create` (assistant message) + `response.create` immediately after session setup. xAI speaks it as the first thing the caller hears.

### Call Action Flow

1. xAI decides to transfer/drop/voicemail → calls function tool
2. Tool executor returns result with `action` field
3. Bridge does **not** send `response.create` (model already acknowledged)
4. `audioWriter.onceDrained()` → waits for current speech to finish
5. SDK method executes (`participant.transfer()` / `drop()` / `transferToVoiceMail()`)

---

## Project Structure

```
src/
├── index.ts                       # Entry point — SDK + MCP init
├── app-config.ts                  # Loads config.yaml
│
├── providers/
│   └── xai-realtime.ts            # xAI WebSocket bridge — audio, events, tool dispatch
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
    └── call-store.ts              # Orchestrator: creates bridge per participant

agents/
└── receptionist.yaml              # Receptionist persona: prompt, tools, policies, screening
```

---

<p align="center">
  <sub>Part of the <a href="../../README.md">Agentic Call Control</a> research project · Built with <a href="https://www.3cx.com">3CX</a> Call Control SDK</sub>
</p>
