# Agentic Call Control — Examples

This repository shows how to connect **external AI voice agent applications** to **3CX PBX** using the [CallControl API](https://www.3cx.com/docs/call-control-api-endpoints/) and the [CallControl SDK](https://github.com/3cx/call-control-sdk-ts). The agents run entirely outside 3CX — on your own infrastructure, using your own AI provider — and interact with the PBX purely through its API: joining calls, streaming audio in/out, and controlling routing (transfer, voicemail, drop) through tool calls. No 3CX source code or modifications required.

All examples use a **single realtime audio stream** (OpenAI Realtime, Gemini Live, xAI Grok, Alibaba Qwen) — STT, reasoning, and TTS happen inside one continuous bidirectional audio stream with no handoff between stages.

All examples support the **3CX MCP server** for phonebook lookups and contact management.

Optional **extra MCP servers** (calendars, CRMs, etc.) can be added via `customMcpServers` in each example’s `config.yaml`. Each server supports token-based authentication — `bearer` (with a token) or `none` for unauthenticated servers:

```yaml
customMcpServers:
  - name: GoogleCalendar
    url: https://mcp.example.com/your-server
    auth:
      type: bearer
      token: your-mcp-bearer-token
    enabled: true

  - name: LocalTools
    url: http://localhost:3001/mcp
    auth:
      type: none
    enabled: true
```

Tools from those servers are merged with 3CX MCP. Only tools listed in the agent profile `mcpTools` are exposed to the model — add each tool by its exact name (e.g. `googlecalendar.quick_add`) in `agents/<profile>.yaml`:

```yaml
mcpTools:
  - list_phonebook
  - googlecalendar.quick_add
```

The agent logic in the examples is simple — it covers a handful of basic receptionist scenarios: contact lookup and call routing (transfer, voicemail, drop). The architecture is fully extensible, and the ceiling is set by your implementation, the tools you expose, and the model you choose to run.

## Quick start

**Requirements:** Node.js 20+, Yarn 4 (bundled), 3CX CallControl app credentials, provider API key for the example you choose.

All examples follow the same setup. From the **repo root**:

```bash
yarn install
cp examples/<example>/config.yaml.example examples/<example>/config.yaml
```

Edit `examples/<example>/config.yaml` with your 3CX credentials (`appId`, `appSecret`, `pbxBase`) and the provider API key. Set `agentProfile: receptionist` (or another profile in `agents/`).

Start the example:

```bash
yarn start:openai            # OpenAI Realtime API
yarn start:alibaba-qwen      # Alibaba Qwen Omni Realtime
yarn start:xai               # xAI Grok Voice Agent
yarn start:gemini            # Gemini Live API
```

**Calling the agent:** dial the Service Principal **Client ID** (`appId`) from any 3CX extension, or the assigned **DID** if you configured one.

Provider-specific config keys and options are documented in each example README:

- [OpenAI Realtime](./examples/openai-realtime/README.md)
- [Alibaba Qwen realtime](./examples/alibaba-qwen-realtime/README.md)
- [xAI Grok realtime](./examples/xai-realtime/README.md)
- [Gemini Live realtime](./examples/gemini-realtime/README.md)

## Choosing an example

| Example | Start command | Best for |
|---------|---------------|----------|
| [OpenAI Realtime](./examples/openai-realtime/README.md) | `yarn start:openai` | Strong tool use, English-first, widely documented API |
| [Gemini Live](./examples/gemini-realtime/README.md) | `yarn start:gemini` | Google ecosystem, multilingual, Live API preview models |
| [xAI Grok](./examples/xai-realtime/README.md) | `yarn start:xai` | Native 8 kHz audio (no resampling), Grok voice models |
| [Alibaba Qwen](./examples/alibaba-qwen-realtime/README.md) | `yarn start:alibaba-qwen` | Chinese/English, DashScope region-specific endpoints |

Each example is a standalone app under `examples/` with the same call flow; only the AI provider bridge differs.

## Architecture

```
Caller → 3CX PBX → Call Control WebSocket → call-store.ts (orchestrator)
                                                    ↓
                                          provider bridge (WebSocket)
                                                    ↓ tool calls
                                    local tools (transfer, drop, screening)
                                    MCP tools (phonebook, custom servers)
```

| Layer | Location | Controls |
|-------|----------|----------|
| PBX connection | `config.yaml` | `appId`, `appSecret`, `pbxBase` |
| AI provider | `config.yaml` | API keys, model, voice, VAD settings |
| Agent behavior | `agents/<profile>.yaml` | Prompt, tools, policies, screening |
| MCP tool allowlist | `mcpTools` in agent profile | Which MCP tools the model can call |

On each incoming call, `call-store.ts` creates a provider bridge, renders the agent prompt, wires tools, and streams audio between the caller and the realtime model.

## Agent profiles

Agent behavior is defined in YAML files under `agents/` in each example. Point to a profile from `config.yaml`:

```yaml
agentProfile: receptionist
companyName: Your Company
agentName: Assistant
```

`companyName` and `agentName` are injected into the profile prompt at runtime. The bundled `receptionist.yaml` covers phonebook lookup, transfers, voicemail, and call screening.

| Profile field | Purpose |
|---------------|---------|
| `role` | Short label (e.g. `receptionist`) |
| `prompt` | System instructions — Mustache template with `{{company_name}}`, `{{agent_name}}`, `{{caller_name}}`, `{{caller_number}}` |
| `greeting` | First spoken line — supports `{{company_name}}`, `{{agent_name}}` |
| `voice` | Provider voice ID (overrides config default) |
| `callScreening` | Require name/company/reason before live transfer |
| `checkAvailability` | Use `isAvailable` from phonebook before transferring |
| `allowedActions` | Enabled call actions: `transfer`, `drop` |
| `mcpTools` | Allowlist of MCP tool names (exact match; use `list_phonebook` to start) |
| `policies` | Rules for spam, hostility, non-cooperative callers (`endcall` or `transfer`) |
| `blockedExtensions` | Extensions the agent must not transfer to |

**Add a new profile:** create `agents/my-agent.yaml`, set `agentProfile: my-agent` in `config.yaml`.

**Legacy mode:** omit `agentProfile` and set `agentInstructions` in `config.yaml` instead (plain text, no YAML features).

See `agents/receptionist.yaml` in any example for a full working profile.

## License

MIT
