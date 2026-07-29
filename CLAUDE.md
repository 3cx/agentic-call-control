# CLAUDE.md

Monorepo of 3CX voice agent **examples**. Each workspace under `examples/` is an independent app from a feature branch. Shared code lives under `packages/`.

## Commands (repo root)

```bash
yarn install
yarn start:openai            # @3cx-examples/openai-realtime
yarn start:alibaba-qwen      # @3cx-examples/alibaba-qwen-realtime
yarn start:xai               # @3cx-examples/xai-realtime
yarn start:gemini            # @3cx-examples/gemini-realtime
yarn build          # all workspaces
yarn lint           # all workspaces
```

Per-example (from `examples/<name>/`): `yarn start`, `yarn build`, `yarn lint`.

## Configuration

- Root `config.yaml.example` — shared 3CX `appId`, `appSecret`, `pbxBase`.
- Each example has `config.yaml.example` with provider-specific fields.
- Runtime reads `config.yaml` from the example directory (`process.cwd()` when started via workspace script).

## Shared packages

| Package                 | Role                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| `@3cx-examples/logger`  | Call logging helpers                                                |
| `@3cx-examples/mcp`     | 3CX MCP client, optional multi-server custom MCP router, McpManager |

`@3cx/call-control-sdk` is installed from public npm (`^0.1.8`), not vendored in this repo.

## Examples

| Folder                           | Branch source           | Stack                                |
| -------------------------------- | ----------------------- | ------------------------------------ |
| `examples/openai-realtime`       | —                       | OpenAI Realtime API WebSocket        |
| `examples/alibaba-qwen-realtime` | `cloud/qwen-realtime`   | Alibaba DashScope Qwen Omni Realtime |
| `examples/xai-realtime`          | `cloud/xai-realtime`    | xAI Grok Voice Agent WebSocket       |
| `examples/gemini-realtime`       | `cloud/gemini-realtime` | Gemini Live API WebSocket            |

## Refreshing an example from a branch

```bash
git archive origin/cloud/qwen-realtime | tar -x -C examples/alibaba-qwen-realtime
```

Then restore `package.json` `name` field to `@3cx-examples/<folder>`.
