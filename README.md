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

**Requirements:** Node.js 20+, Yarn 4 (bundled), 3CX CallControl app credentials, provider API key(s) for the example you choose.

1. Clone or download the repository, then install dependencies from the repo root:

```bash
yarn install
```

2. Follow the setup instructions for your chosen example:
   - [OpenAI Realtime](./examples/openai-realtime/README.md) — OpenAI Realtime API
   - [Alibaba Qwen realtime](./examples/alibaba-qwen-realtime/README.md) — DashScope Qwen Omni Realtime
   - [xAI Grok realtime](./examples/xai-realtime/README.md) — xAI Grok Voice Agent
   - [Gemini Live realtime](./examples/gemini-realtime/README.md) — Gemini Live API
   - [Web Dialer](./examples/web-dialer/README.md) — browser microphone and speaker calling without SIP registration

3. When ready, start from the repo root:

```bash
yarn start:openai            # OpenAI Realtime API
yarn start:alibaba-qwen      # Alibaba Qwen Omni Realtime
yarn start:xai               # xAI Grok Voice Agent
yarn start:gemini            # Gemini Live realtime
yarn start:web-dialer        # Browser dialer (no SIP registration)
```

## License

MIT
