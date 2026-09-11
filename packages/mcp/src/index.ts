export {
    connectMcp,
    filterMcpTools,
    callMcpTool,
} from './mcp-client.ts';
export type { McpToolDefinition } from './mcp-client.ts';

export {
    normalizeToolParameters,
    normalizeToolDefinition,
    normalizeToolDefinitions,
    sanitizeToolName,
    coerceToolArguments,
} from './tool-schema.ts';
export type {
    ToolSchemaProvider,
    ToolDefinitionInput,
    NormalizedToolDefinition,
    NormalizedToolSet,
} from './tool-schema.ts';

export {
    CustomMcpConnection,
    CustomMcpRouter,
    connectCustomMcpServers,
} from './custom-mcp-client.ts';
export type {
    CustomMcpAuth,
    CustomMcpServerConfig,
    CustomMcpToolDef,
    ConnectCustomMcpOptions,
} from './custom-mcp-client.ts';

export {
    CustomMcpConfigError,
    InteractiveAuthRequiredError,
    DEFAULT_REDIRECT_URI,
    mcpAuthRecoveryCommand,
} from './custom-mcp-auth.ts';

export {
    loadCustomMcpServers,
    normalizeCustomMcpAuth,
    normalizeCustomMcpServer,
    parseLoopbackRedirectUri,
    findAuthorizationCodeServer,
} from './custom-mcp-config.ts';
export type {
    NormalizedCustomMcpAuth,
    NormalizedCustomMcpServer,
} from './custom-mcp-config.ts';

export { FileTokenStore, TokenStoreLock, TOKEN_STORE_VERSION } from './oauth-token-store.ts';
export { FileBackedAuthCodeProvider } from './oauth-auth-code-provider.ts';
export { runMcpAuth, parseMcpAuthArgs, configBaseDir } from './mcp-auth-cli.ts';

export { McpManager } from './mcp-manager.ts';
export type { McpManagerConfig } from './mcp-manager.ts';
