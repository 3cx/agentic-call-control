import { randomBytes, timingSafeEqual } from 'node:crypto';
import type {
    OAuthClientProvider,
    OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
    OAuthClientInformation,
    OAuthClientMetadata,
    OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { InteractiveAuthRequiredError, mcpAuthRecoveryCommand } from './custom-mcp-auth.ts';
import type { NormalizedCustomMcpAuth } from './custom-mcp-config.ts';
import { FileTokenStore } from './oauth-token-store.ts';

export interface AuthCodeProviderOptions {
    serverName: string;
    mcpUrl: string;
    auth: Extract<NormalizedCustomMcpAuth, { grant: 'authorization_code' }>;
    configPath: string;
    /** When true, redirectToAuthorization records the URL instead of throwing. */
    interactive: boolean;
}

export class FileBackedAuthCodeProvider implements OAuthClientProvider {
    readonly store: FileTokenStore;
    private readonly opts: AuthCodeProviderOptions;
    private pendingAuthorizationUrl: URL | undefined;
    private memoryVerifier: string | undefined;
    private memoryState: string | undefined;

    constructor(opts: AuthCodeProviderOptions) {
        this.opts = opts;
        this.store = new FileTokenStore(opts.auth.tokenStore);
    }

    get redirectUrl(): string {
        return this.opts.auth.redirectUri;
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            redirect_uris: [this.opts.auth.redirectUri],
            client_name: 'agentic-call-control',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: this.opts.auth.clientSecret ? 'client_secret_basic' : 'none',
            scope: this.opts.auth.scope,
        };
    }

    clientInformation(): OAuthClientInformation {
        return {
            client_id: this.opts.auth.clientId,
            client_secret: this.opts.auth.clientSecret,
        };
    }

    async state(): Promise<string> {
        if (this.memoryState) return this.memoryState;
        const state = randomBytes(32).toString('hex');
        this.memoryState = state;
        await this.store.update((current) => ({ ...current, expectedState: state }));
        return state;
    }

    async tokens(): Promise<OAuthTokens | undefined> {
        const file = await this.store.read();
        return file?.tokens;
    }

    async saveTokens(tokens: OAuthTokens): Promise<void> {
        await this.store.update((current) => ({
            ...current,
            tokens,
            codeVerifier: undefined,
            expectedState: undefined,
        }));
    }

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
        if (this.opts.interactive) {
            this.pendingAuthorizationUrl = authorizationUrl;
            return;
        }
        throw new InteractiveAuthRequiredError(
            mcpAuthRecoveryCommand(this.opts.configPath, this.opts.serverName),
        );
    }

    takeAuthorizationUrl(): URL | undefined {
        const url = this.pendingAuthorizationUrl;
        this.pendingAuthorizationUrl = undefined;
        return url;
    }

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
        this.memoryVerifier = codeVerifier;
        await this.store.update((current) => ({ ...current, codeVerifier }));
    }

    async codeVerifier(): Promise<string> {
        if (this.memoryVerifier) return this.memoryVerifier;
        const file = await this.store.read();
        if (!file?.codeVerifier) {
            throw new Error('No PKCE code verifier is available');
        }
        return file.codeVerifier;
    }

    async expectedState(): Promise<string | undefined> {
        if (this.memoryState) return this.memoryState;
        const file = await this.store.read();
        return file?.expectedState;
    }

    async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
        await this.store.update((current) => ({ ...current, discovery: state }));
    }

    async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
        const file = await this.store.read();
        return file?.discovery;
    }

    async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
        await this.store.update((current) => {
            const next = { ...current };
            if (scope === 'all' || scope === 'tokens') {
                delete next.tokens;
            }
            if (scope === 'all' || scope === 'verifier') {
                delete next.codeVerifier;
                this.memoryVerifier = undefined;
            }
            if (scope === 'all' || scope === 'discovery') {
                delete next.discovery;
            }
            if (scope === 'all') {
                delete next.expectedState;
                this.memoryState = undefined;
            }
            return next;
        });
    }

    recoveryCommand(): string {
        return mcpAuthRecoveryCommand(this.opts.configPath, this.opts.serverName);
    }
}

export function timingSafeEqualString(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) {
        const dummy = Buffer.alloc(left.length);
        timingSafeEqual(left, dummy);
        return false;
    }
    return timingSafeEqual(left, right);
}
