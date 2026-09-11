export type CustomMcpAuth =
    | { type: 'none' }
    | { type: 'bearer'; token: string }
    | {
        type: 'oauth';
        grant?: 'client_credentials';
        clientId: string;
        clientSecret: string;
        scope?: string;
    }
    | {
        type: 'oauth';
        grant: 'authorization_code';
        clientId: string;
        clientSecret?: string;
        redirectUri?: string;
        tokenStore: string;
        scope?: string;
    };

export interface CustomMcpServerConfig {
    name: string;
    url: string;
    auth?: CustomMcpAuth;
    /** Defaults to true when omitted. */
    enabled?: boolean;
}

export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8765/callback';

export class CustomMcpConfigError extends Error {
    readonly serverName: string;
    readonly field: string;

    constructor(serverName: string, field: string, message: string) {
        super(`[CustomMCP] "${serverName}" invalid ${field}: ${message}`);
        this.name = 'CustomMcpConfigError';
        this.serverName = serverName;
        this.field = field;
    }
}

export class InteractiveAuthRequiredError extends Error {
    readonly recoveryCommand: string;

    constructor(recoveryCommand: string, message?: string) {
        super(message ?? `Authorization required. Run: ${recoveryCommand}`);
        this.name = 'InteractiveAuthRequiredError';
        this.recoveryCommand = recoveryCommand;
    }
}

export function mcpAuthRecoveryCommand(configPath: string, serverName: string): string {
    const quoted = /\s/.test(configPath) ? `"${configPath}"` : configPath;
    return `yarn mcp:auth --config ${quoted} ${serverName}`;
}
