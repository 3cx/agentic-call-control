# Agentic Call Control — `gemini-realtime`

This example uses the **Google Gemini Live API** — a single WebSocket connection that handles speech recognition, LLM reasoning, and speech synthesis simultaneously.

---

## Prerequisites

### 3CX Service Principal

Create API credentials so the agent can control calls on your PBX:

1. Open your 3CX Web Client
2. Go to **Admin → Integrations → API**
3. Click **Add Service Principal**
4. Set a **Client ID** (e.g. `assistant`) — this becomes your `appId`
5. Enable **"Enable access to the 3CX Call Control API for this application"**
6. *(Optional)* Assign a **DID Number** (the phone number callers will dial)
7. *(Optional)* Click **Select Extensions** to choose which extensions the agent can control
8. **Save** — the generated Client Secret becomes your `appSecret`

### Gemini API Key

Get an API key from [Google AI Studio](https://aistudio.google.com/apikey).

---

## Quick Start

From the **repo root**:

```bash
yarn install
cp examples/gemini-realtime/config.yaml.example examples/gemini-realtime/config.yaml
```

Edit `examples/gemini-realtime/config.yaml`:

```yaml
# 3CX Service Principal — Web Client → Admin → Integrations → API
appId: your-client-id       # Service Principal Client ID
appSecret: your-client-secret  # Service Principal API key
pbxBase: https://your-pbx.3cx.eu:5001  # Your PBX FQDN

# Google Gemini API key — https://aistudio.google.com/apikey
geminiApiKey: your-gemini-api-key

# Gemini voice (default: Kore). Options: Kore, Charon, Fenrir, Aoede, Puck, etc.
geminiVoice: Kore

# Gemini model
geminiModel: models/gemini-3.1-flash-live-preview

# Agent profile — loads from agents/<name>.yaml
agentProfile: receptionist
companyName: Your Company
agentName: Assistant
```

Start the example:

```bash
yarn start:gemini
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
       └─ gemini-live.ts → Gemini Live API WebSocket (gemini-3.1-flash-live)
            ├─ audio 8 kHz → upsample 16 kHz → model input
            ├─ tool calls → tool-executor
            │                ├─ local tools (transfer/voicemail/drop/screening) → routing
            │                └─ MCP tools (phonebook/contacts) → data lookup
            └─ model output → downsample 24 kHz → 8 kHz → caller hears audio
```

No separate STT, LLM, or TTS pipeline — the realtime model handles conversation audio end-to-end.

---

## Tools

### Local Tools (SDK-backed)

Gemini calls these as function tools. The app executes them via the 3CX SDK.

| Tool | What it does | Behavior |
|---|---|---|
| `transfer_call` | `participant.transfer(ext)` | Waits for audio drain, then transfers. Blocked if screening incomplete. |
| `drop_call` | `participant.drop()` | Waits for audio drain (caller hears goodbye), then drops. |
| `transfer_to_voicemail` | `participant.transferToVoiceMail(ext)` | Same guards as transfer |
| `update_screening` | Saves `name`, `company`, or `reason` | Side-effect tool — no extra response trigger needed |

### MCP Tools (PBX Server)

Fetched from 3CX MCP at startup, converted to Gemini function declaration format, proxied locally.

| Tool | What it does |
|---|---|
| `list_phonebook` | Search PBX phonebook by name, extension, or email. Returns `isAvailable`. |

### Extra MCP servers

Optional servers beyond `{pbxBase}/mcp` — see `customMcpServers` in `config.yaml.example`. After connecting a server, add each tool you want the agent to use to `mcpTools` in `agents/<profile>.yaml` (exact name from the startup log):

```yaml
mcpTools:
  - list_phonebook
  - googlecalendar.quick_add
```

Only listed tools are exposed; everything else stays disabled (`✗` in the startup log).

<br>

---

<br>

## Key Implementation Details

### WebSocket Connection

```
wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<API_KEY>
```

### Session Configuration

On connect, the `setup` message configures:
- **model** — from config (default: `models/gemini-3.1-flash-live-preview`)
- **voice** — from config (`Kore`, `Charon`, `Fenrir`, etc.)
- **systemInstruction** — rendered from agent profile (Mustache template)
- **tools** — merged local + MCP function declarations
- **realtimeInputConfig** — `automaticActivityDetection` with configurable `silenceDurationMs`
- **transcription** — both input and output transcription enabled

### Greeting

After `setupComplete`, a `clientContent` message triggers Gemini to speak the greeting as the first thing the caller hears. If a `greeting` is configured in the agent profile, the instruction is `[Call connected. Say exactly: "<greeting>"]`; otherwise it falls back to `[Call connected. Greet the caller now.]`.

### Call Action Flow

1. Gemini decides to transfer/drop/voicemail → calls function tool
2. Tool executor returns result with `action` field
3. Tool responses sent back to Gemini
4. `audioWriter.onceDrained()` → waits for current speech to finish
5. SDK method executes (`participant.transfer()` / `drop()` / `transferToVoiceMail()`)

### Agent Profiles

See [Agent profiles](../../README.md#agent-profiles) in the root README. Example: `agents/receptionist.yaml`.

---

## Project Structure

```
src/
├── index.ts                       # Entry point — SDK + MCP init
├── app-config.ts                  # Loads config.yaml
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
    └── sentence-accumulator.ts    # Buffers transcript fragments into complete sentences

agents/
└── receptionist.yaml              # Receptionist persona: role, tools, policies, screening config
```

---

<p align="center">
  <sub>Part of the <a href="../../README.md">Agentic Call Control</a> research project · Built with <a href="https://www.3cx.com">3CX</a> Call Control SDK</sub>
</p>
