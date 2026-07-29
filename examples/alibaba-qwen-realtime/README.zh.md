# 智能呼叫控制 — 阿里云通义千问实时语音

一个通过 CallControl SDK 连接到 **3CX PBX** 的 AI 语音代理，使用**阿里云 DashScope 通义千问全模态实时**——单条 WebSocket 连接实现端到端语音对话，无需独立的 STT/LLM/TTS 流水线。

---

## 前置条件

### 3CX 服务主体

创建 API 凭证，使代理能够控制 PBX 上的通话：

1. 打开 3CX Web 客户端
2. 进入 **管理 → 集成 → API**
3. 点击 **添加服务主体**
4. 设置**客户端 ID**（例如 `assistant`）——这将成为你的 `appId`
5. 启用 **"为此应用程序启用 3CX 呼叫控制 API 访问"**
6. *(可选)* 分配一个 **DID 号码**（呼叫者拨打的电话号码）
7. *(可选)* 点击**选择分机**，选择代理可控制的分机
8. **保存** ——生成的客户端密钥即为你的 `appSecret`

### DashScope API 密钥

从[阿里云 DashScope 控制台](https://dashscope.console.aliyun.com/)获取 API 密钥。

> **注意：** DashScope API 密钥与地区绑定。中国大陆地区的密钥需使用 `dashscopeBaseUrl: https://dashscope.aliyuncs.com`；国际控制台（新加坡）的密钥使用 `https://dashscope-intl.aliyuncs.com`。端点与密钥地区不匹配将导致认证失败。

---

## 快速开始

在仓库根目录复制配置文件：

```bash
cp examples/alibaba-qwen-realtime/config.yaml.example examples/alibaba-qwen-realtime/config.yaml
```

填写凭证——打开 `examples/alibaba-qwen-realtime/config.yaml`：

```yaml
# 3CX 服务主体 — Web 客户端 → 管理 → 集成 → API
appId: your-client-id          # 服务主体客户端 ID
appSecret: your-client-secret  # 服务主体 API 密钥
pbxBase: https://your-pbx.3cx.eu:5001  # 你的 PBX FQDN

# 阿里云 DashScope API 密钥 — https://dashscope.console.aliyun.com/
dashscopeApiKey: sk-your-dashscope-api-key
dashscopeBaseUrl: https://dashscope-intl.aliyuncs.com  # API 密钥与地区绑定 — 中国大陆地区密钥请使用 https://dashscope.aliyuncs.com
realtimeModel: qwen3.5-omni-plus-realtime
realtimeVoice: male-qn-qingse  # male-qn-qingse | female-shaonv | male-qn-jingying | female-tianmei
realtimeVadSilenceDurationMs: 800  # 服务端 VAD 静音阈值（可选）

# 代理配置文件 — 从 agents/<name>.yaml 加载
agentProfile: receptionist
companyName: Your Company
agentName: Assistant
```

然后在仓库根目录启动：

```bash
yarn start:alibaba-qwen
```

### 呼叫代理

代理运行后，有两种方式在 3CX PBX 上接通它：

- **内部呼叫** ——从任何已注册的 3CX 分机（桌面电话、Web 客户端或移动应用），拨打**客户端 ID**（配置的 `appId`，例如 `assistant`）。PBX 将直接把呼叫路由到代理。
- **外部呼叫（DID）** ——如果你为服务主体分配了 DID 号码（上面的第 6 步），外部线路上的呼叫者可以拨打该电话号码接通代理。

---

## 架构

```
3CX 来电
  └─ WebSocket 事件 → call-store.ts（编排器）
       └─ qwen-realtime.ts → DashScope 全模态实时 WebSocket
            ├─ 音频 8 kHz → 上采样 16 kHz → 模型输入
            ├─ 工具调用 → tool-executor.ts
            │                ├─ 本地工具（转接/语音邮件/挂断/筛选）→ 路由
            │                └─ MCP 工具 → callMcpTool → 3CX MCP 服务器
            └─ 模型输出 → 下采样 24 kHz → 8 kHz → 呼叫者听到音频
```

无独立的 STT、LLM 或 TTS 流水线——实时模型端到端处理对话音频。

---

## 工具

### 本地工具（SDK 支持）

| 工具 | 功能 | 行为 |
|---|---|---|
| `transfer_call` | `participant.transfer(ext)` | 等待音频传输完成后转接，筛选未完成时阻止 |
| `drop_call` | `participant.drop()` | 等待音频传输完成（呼叫者听到再见），然后挂断 |
| `transfer_to_voicemail` | `participant.transferToVoiceMail(ext)` | 与转接相同的保护机制 |
| `update_screening` | 保存呼叫者的 `name`、`company` 或 `reason` | 仅在代理配置中启用 `callScreening` 时可用 |

### MCP 工具

MCP 服务器在启动时通过 `mcp-client.ts` 连接。其工具将被自动发现、转换为 DashScope 工具格式，并传递给实时会话。

```typescript
// index.ts
const mcpClient = await connectMcp(client.getMcpUrl(), client.createMcpAuthProvider());
const mcpToolDefs = await listMcpTools(mcpClient, allowedTools);
const mcpToolsQwen = mcpToolsToQwen(mcpToolDefs);
const mcpCaller = (name, args) => callMcpTool(mcpClient, name, args);

createCallStore(client, appconfig, mcpToolsQwen, mcpCaller);
```

---

## 关键实现细节

### 配置

| 设置 | 说明 |
|---|---|
| `dashscopeApiKey` | 阿里云 DashScope API 密钥 |
| `dashscopeBaseUrl` | `https://dashscope-intl.aliyuncs.com`（新加坡）或 `https://dashscope.aliyuncs.com`（中国大陆）— **API 密钥与地区绑定**，请使用与密钥创建地区匹配的 URL |
| `realtimeModel` | 例如 `qwen3.5-omni-plus-realtime` |
| `realtimeVoice` | 语音（默认：`male-qn-qingse`）——`male-qn-qingse`、`female-shaonv`、`male-qn-jingying`、`female-tianmei` |
| `realtimeVadSilenceDurationMs` | 服务端 VAD 静音阈值（毫秒，可选，未指定时使用模型默认值） |
| `agentProfile` | 从 `agents/<name>.yaml` 加载代理人设 |
| `companyName` / `agentName` | 注入到系统提示中 |
| `saveAudioToFile` / `audioOutputDir` | 将呼叫者音频保存为 WAV 文件以供调试 |

### 音频流水线

| 阶段 | 格式 |
|---|---|
| 3CX 入站流 | PCM 8 kHz 16位单声道 |
| 千问实时输入 | PCM 16 kHz 16位单声道（线性插值 2:1 上采样） |
| 千问实时输出 | PCM 24 kHz 16位单声道 |
| 3CX 出站流 | PCM 8 kHz 16位单声道（3:1 抽取下采样） |

### 打断（Barge-In）

千问实时模型通过服务端 VAD 自动处理打断。当呼叫者开始说话时，模型停止生成音频，无需客户端打断逻辑。

---

## 项目结构

```
src/
├── index.ts                          # 入口 — 连接 3CX、MCP 初始化、启动呼叫存储
├── app-config.ts                     # 加载 config.yaml，导出 AppConfig 接口
└── callcontrol/
    ├── call-store.ts                 # 每通呼叫的编排器 — 连接实时桥接与工具执行器
    └── utils.ts                      # CallControl 状态辅助函数
└── providers/
    └── qwen-realtime.ts              # DashScope 全模态实时 WebSocket 桥接
└── agent/
    ├── agent-profiles.ts             # 加载 agents/<name>.yaml，渲染系统提示
    ├── tool-executor.ts              # 本地工具执行（转接、挂断、筛选）
    └── tools.ts                      # 千问格式的工具定义
└── mcp/
    ├── mcp-client.ts                 # MCP 客户端：连接、列出工具、调用工具
    └── mcp-to-qwen.ts                # 将 MCP 工具 schema 转换为 DashScope 格式
└── audio/
    └── audio-utils.ts                # PCM 辅助函数：8k→16k 上采样，24k→8k 下采样
└── logging/
    └── call-logger.ts                # 每通呼叫的对话日志记录器
```

`@3cx/call-control-sdk` 包提供 OAuth2 客户端、WebSocket 连接和 REST API 调用——这些不在本仓库范围内。

---

<p align="center">
  <sub>属于 <a href="../../README.md">Agentic Call Control</a> 示例集 · 基于 <a href="https://www.3cx.com">3CX</a> Call Control SDK 构建</sub>
</p>
