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
} from './custom-mcp-client.ts';

export { McpManager } from './mcp-manager.ts';
export type { McpManagerConfig } from './mcp-manager.ts';
