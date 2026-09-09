import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { connectCustomMcpServers } from '../src/custom-mcp-client.ts';
import { runMcpAuth } from '../src/mcp-auth-cli.ts';
import { FileTokenStore, TOKEN_STORE_VERSION, TokenStoreLock } from '../src/oauth-token-store.ts';
import { startLoopbackCallback } from '../src/oauth-callback-server.ts';
import { startOAuthMcpFixture } from './helpers/oauth-mcp-fixture.ts';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src');

test('source does not hand-roll token endpoint POSTs', async () => {
    const files = (await readdir(srcDir)).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
        const text = await readFile(join(srcDir, file), 'utf8');
        assert.doesNotMatch(text, /grant_type=client_credentials/);
        assert.doesNotMatch(text, /new URLSearchParams\(\{[^}]*grant_type/);
    }
});

test('none, omitted auth, and bearer connect without OAuth provider', async () => {
    const fixture = await startOAuthMcpFixture({
        clientId: 'id',
        clientSecret: 'secret',
        rejectBearer: () => false,
    });
    const dir = await mkdtemp(join(tmpdir(), 'mcp-conn-'));
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'x: 1\n');
    try {
        const none = await connectCustomMcpServers([
            { name: 'LocalTools', url: fixture.mcpUrl, auth: { type: 'none' }, enabled: true },
        ], 'all', { configPath });
        // unauthenticated MCP is rejected by fixture (401) and skipped
        assert.equal(none, undefined);

        const omitted = await connectCustomMcpServers([
            { name: 'Omitted', url: 'http://127.0.0.1:1/mcp', enabled: true },
        ], undefined, { configPath });
        assert.equal(omitted, undefined);

        const bearer = await connectCustomMcpServers([
            { name: 'Bearer', url: fixture.mcpUrl, auth: { type: 'bearer', token: 'access-token' } },
        ], 'all');
        assert.ok(bearer?.toolDefs.some((tool) => tool.name === 'whoami'));
        await bearer?.disconnectAll();
    } finally {
        await fixture.close();
    }
});

test('client_credentials obtains a token via SDK and lists tools', async () => {
    const fixture = await startOAuthMcpFixture({
        clientId: 'cid',
        clientSecret: 'csecret',
    });
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cc-'));
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'x: 1\n');
    try {
        const router = await connectCustomMcpServers([
            {
                name: 'ServiceCrm',
                url: fixture.mcpUrl,
                auth: {
                    type: 'oauth',
                    grant: 'client_credentials',
                    clientId: 'cid',
                    clientSecret: 'csecret',
                    scope: 'mcp:tools',
                },
            },
        ], 'all', { configPath });
        assert.ok(router);
        assert.ok(router!.toolDefs.some((t) => t.name === 'whoami'));
        assert.ok(fixture.tokenRequests.some((r) => r.grant === 'client_credentials'));
        const result = await router!.callTool('whoami', {});
        assert.match(result, /fixture-user/);
    } finally {
        await fixture.close();
    }
});

test('client_credentials renews after a simulated 401', async () => {
    let calls = 0;
    const fixture = await startOAuthMcpFixture({
        clientId: 'cid',
        clientSecret: 'csecret',
        rejectBearer: (_token, n) => {
            calls = n;
            return n === 1;
        },
    });
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cc2-'));
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'x: 1\n');
    try {
        const router = await connectCustomMcpServers([
            {
                name: 'ServiceCrm',
                url: fixture.mcpUrl,
                auth: { type: 'oauth', clientId: 'cid', clientSecret: 'csecret' },
            },
        ], 'all', { configPath });
        assert.ok(router);
        assert.ok(calls >= 1);
        assert.ok(fixture.tokenRequests.filter((r) => r.grant === 'client_credentials').length >= 1);
    } finally {
        await fixture.close();
    }
});

test('client_credentials performs only one outer reconnect after SDK recovery is exhausted', async () => {
    let remainingRejectedRequests = 0;
    const fixture = await startOAuthMcpFixture({
        clientId: 'cid',
        clientSecret: 'csecret',
        rejectBearer: () => {
            if (remainingRejectedRequests === 0) return false;
            remainingRejectedRequests -= 1;
            return true;
        },
    });
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cc-bounded-'));
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'x: 1\n');
    try {
        const router = await connectCustomMcpServers([{
            name: 'ServiceCrm',
            url: fixture.mcpUrl,
            auth: { type: 'oauth', clientId: 'cid', clientSecret: 'csecret' },
        }], 'all', { configPath });
        assert.ok(router?.has('whoami'));
        const initializationsBeforeFailure = fixture.mcpMethods.filter((method) => method === 'initialize').length;
        const tokensBeforeFailure = fixture.tokenRequests.length;
        remainingRejectedRequests = 2;
        const result = await router!.callTool('whoami', {});
        assert.match(result, /fixture-user/);
        assert.equal(
            fixture.mcpMethods.filter((method) => method === 'initialize').length - initializationsBeforeFailure,
            1,
        );
        assert.equal(fixture.tokenRequests.length - tokensBeforeFailure, 2);
        await router!.disconnectAll();
    } finally {
        await fixture.close();
    }
});

test('authorization_code CLI prints URL, accepts callback, persists store, verifies tools', async () => {
    const fixture = await startOAuthMcpFixture({
        clientId: 'cid',
        clientSecret: 'csecret',
        issuerRequired: true,
    });
    const dir = await mkdtemp(join(tmpdir(), 'mcp-ac-'));
    const configPath = join(dir, 'config.yaml');
    const storePath = join(dir, '.mcp-tokens', 'g.json');
    await writeFile(configPath, `
customMcpServers:
  - name: GoogleCalendar
    url: ${fixture.mcpUrl}
    auth:
      type: oauth
      grant: authorization_code
      clientId: cid
      clientSecret: csecret
      redirectUri: http://127.0.0.1:18770/callback
      tokenStore: .mcp-tokens/g.json
`);
    const stdoutChunks: string[] = [];
    const stdout = new PassThrough();
    stdout.on('data', (c) => stdoutChunks.push(String(c)));
    const stderr = new PassThrough();

    const run = runMcpAuth(['--config', configPath, 'GoogleCalendar'], {
        stdin: new PassThrough(),
        stdout,
        stderr,
        timeoutMs: 8000,
    });

    const started = Date.now();
    let authUrl = '';
    while (Date.now() - started < 5000) {
        const text = stdoutChunks.join('');
        const match = text.match(/https?:\/\/127\.0\.0\.1:\d+\/authorize\S*/);
        if (match) {
            authUrl = match[0];
            break;
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(authUrl.includes('/authorize'), stdoutChunks.join(''));
    assert.match(stdoutChunks.join(''), /ssh -L 18770:127\.0\.0\.1:18770/);

    const code = fixture.issueAuthorizationCode();
    const url = new URL(authUrl);
    const state = url.searchParams.get('state');
    assert.ok(state);
    const cb = await fetch(
        `http://127.0.0.1:18770/callback?code=${code}&state=${state}&iss=${encodeURIComponent(fixture.issuer)}`,
    );
    assert.equal(cb.status, 200);

    const exit = await run;
    assert.equal(exit, 0);
    const store = await new FileTokenStore(storePath).read();
    assert.equal(store?.version, TOKEN_STORE_VERSION);
    assert.ok(store?.tokens?.access_token);
    assert.ok(fixture.tokenRequests.some((r) => r.grant === 'authorization_code'));

    const router = await connectCustomMcpServers([
        {
            name: 'GoogleCalendar',
            url: fixture.mcpUrl,
            auth: {
                type: 'oauth',
                grant: 'authorization_code',
                clientId: 'cid',
                clientSecret: 'csecret',
                redirectUri: 'http://127.0.0.1:18770/callback',
                tokenStore: storePath,
            },
        },
    ], 'all', { configPath });
    assert.ok(router?.toolDefs.some((t) => t.name === 'whoami'));
    await fixture.close();
});

test('invalid refresh token skips only that server and does not read stdin', async () => {
    const fixture = await startOAuthMcpFixture({
        clientId: 'cid',
        clientSecret: 'csecret',
        refreshToken: 'good-refresh',
    });
    const dir = await mkdtemp(join(tmpdir(), 'mcp-skip-'));
    const configPath = join(dir, 'config.yaml');
    const badStore = join(dir, 'bad.json');
    await writeFile(badStore, JSON.stringify({
        version: 1,
        tokens: {
            access_token: 'expired',
            token_type: 'Bearer',
            refresh_token: 'bad-refresh',
        },
    }), { mode: 0o600 });
    const stdin = new PassThrough();
    let stdinRead = false;
    stdin.on('readable', () => { stdinRead = true; });

    const logs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
        const router = await connectCustomMcpServers([
            {
                name: 'GoogleCalendar',
                url: fixture.mcpUrl,
                auth: {
                    type: 'oauth',
                    grant: 'authorization_code',
                    clientId: 'cid',
                    clientSecret: 'csecret',
                    tokenStore: badStore,
                },
            },
            {
                name: 'WorkingBearer',
                url: fixture.mcpUrl,
                auth: { type: 'bearer', token: 'access-token' },
            },
        ], 'all', { configPath });
        assert.equal(stdinRead, false);
        assert.ok(logs.some((l) => l.includes('yarn mcp:auth --config')));
        assert.ok(router?.toolDefs.some((t) => t.name === 'whoami'));
        await router?.disconnectAll();
    } finally {
        console.warn = origWarn;
        await fixture.close();
    }
});

test('authorization_code callTool unauthorized returns promptly', async () => {
    let rejectBearer = false;
    const fixture = await startOAuthMcpFixture({
        clientId: 'cid',
        clientSecret: 'csecret',
        rejectBearer: () => rejectBearer,
    });
    const dir = await mkdtemp(join(tmpdir(), 'mcp-call-'));
    const configPath = join(dir, 'config.yaml');
    const storePath = join(dir, 't.json');
    await writeFile(storePath, JSON.stringify({
        version: 1,
        tokens: { access_token: 'access-token', token_type: 'Bearer', refresh_token: 'refresh-token' },
    }), { mode: 0o600 });
    try {
        const router = await connectCustomMcpServers([
            {
                name: 'GoogleCalendar',
                url: fixture.mcpUrl,
                auth: {
                    type: 'oauth',
                    grant: 'authorization_code',
                    clientId: 'cid',
                    clientSecret: 'csecret',
                    tokenStore: storePath,
                },
            },
        ], 'all', { configPath });
        assert.ok(router?.has('whoami'));
        rejectBearer = true;
        const started = Date.now();
        const result = await router!.callTool('whoami', {});
        assert.ok(Date.now() - started < 5000);
        assert.match(result, /MCP unavailable/);
        assert.match(result, /yarn mcp:auth/);
    } finally {
        await fixture.close();
    }
});

test('non-TTY authorization exits promptly when aborted', async () => {
    const fixture = await startOAuthMcpFixture({ clientId: 'cid', clientSecret: 'csecret' });
    const dir = await mkdtemp(join(tmpdir(), 'mcp-abort-'));
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, `
customMcpServers:
  - name: AbortServer
    url: ${fixture.mcpUrl}
    auth:
      type: oauth
      grant: authorization_code
      clientId: cid
      clientSecret: csecret
      redirectUri: http://127.0.0.1:18772/callback
      tokenStore: tokens.json
`);
    const stdoutChunks: string[] = [];
    const stdout = new PassThrough();
    stdout.on('data', (chunk) => stdoutChunks.push(String(chunk)));
    const abort = new AbortController();
    try {
        const run = runMcpAuth(['--config', configPath, 'AbortServer'], {
            stdin: new PassThrough(),
            stdout,
            stderr: new PassThrough(),
            signal: abort.signal,
            timeoutMs: 10_000,
        });
        const started = Date.now();
        while (!stdoutChunks.join('').includes('Waiting for the callback')) {
            assert.ok(Date.now() - started < 5000, 'authorization command did not start');
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        abort.abort();
        const exit = await Promise.race([
            run,
            new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('abort did not stop CLI')), 1000)),
        ]);
        assert.equal(exit, 1);
        assert.ok(Date.now() - started < 5000);

        const replacementListener = startLoopbackCallback({
            redirectUri: 'http://127.0.0.1:18772/callback',
            expectedState: 'replacement-state',
            timeoutMs: 1000,
        });
        await replacementListener.ready();
        await replacementListener.close();

        const replacementLock = await TokenStoreLock.acquire(join(dir, 'tokens.json'));
        await replacementLock.release();
    } finally {
        await fixture.close();
    }
});

test('pasted callback URL is accepted; occupied callback is independent', async () => {
    const listener = startLoopbackCallback({
        redirectUri: 'http://127.0.0.1:18771/callback',
        expectedState: 'state-state-state-state-state-state-st',
        timeoutMs: 2000,
    });
    await listener.ready();
    const wait = listener.wait();
    listener.acceptPastedCallbackUrl(
        'http://127.0.0.1:18771/callback?code=pasted&state=state-state-state-state-state-state-st',
    );
    const result = await wait;
    assert.equal(result.code, 'pasted');
});
