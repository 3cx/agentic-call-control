import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
    CustomMcpConfigError,
    loadCustomMcpServers,
    normalizeCustomMcpAuth,
    parseLoopbackRedirectUri,
} from '../src/index.ts';

const cfg = '/tmp/example/config.yaml';

test('omitted auth is none', () => {
    const auth = normalizeCustomMcpAuth('s', undefined, cfg);
    assert.equal(auth.type, 'none');
});

test('explicit none', () => {
    const auth = normalizeCustomMcpAuth('s', { type: 'none' }, cfg);
    assert.equal(auth.type, 'none');
});

test('bearer requires token', () => {
    assert.throws(() => normalizeCustomMcpAuth('s', { type: 'bearer' }, cfg), CustomMcpConfigError);
    const auth = normalizeCustomMcpAuth('s', { type: 'bearer', token: 'abc' }, cfg);
    assert.equal(auth.type, 'bearer');
    if (auth.type === 'bearer') assert.equal(auth.token, 'abc');
});

test('oauth defaults to client_credentials', () => {
    const auth = normalizeCustomMcpAuth('s', {
        type: 'oauth',
        clientId: 'id',
        clientSecret: 'secret',
    }, cfg);
    assert.equal(auth.type, 'oauth');
    if (auth.type === 'oauth') assert.equal(auth.grant, 'client_credentials');
});

test('client_credentials requires secret and forbids tokenStore', () => {
    assert.throws(() => normalizeCustomMcpAuth('s', { type: 'oauth', clientId: 'id' }, cfg), /clientSecret/);
    assert.throws(() => normalizeCustomMcpAuth('s', {
        type: 'oauth',
        grant: 'client_credentials',
        clientId: 'id',
        clientSecret: 's',
        tokenStore: 'x.json',
    }, cfg), /tokenStore/);
});

test('authorization_code requires tokenStore and clientId', () => {
    assert.throws(() => normalizeCustomMcpAuth('s', {
        type: 'oauth',
        grant: 'authorization_code',
        clientId: 'id',
    }, cfg), /tokenStore/);
    const auth = normalizeCustomMcpAuth('s', {
        type: 'oauth',
        grant: 'authorization_code',
        clientId: 'id',
        tokenStore: '.mcp-tokens/x.json',
    }, cfg);
    assert.equal(auth.type, 'oauth');
    if (auth.type === 'oauth' && auth.grant === 'authorization_code') {
        assert.equal(auth.tokenStore, '/tmp/example/.mcp-tokens/x.json');
        assert.equal(auth.redirectUri, 'http://127.0.0.1:8765/callback');
    }
});

test('unsupported grant and type', () => {
    assert.throws(() => normalizeCustomMcpAuth('s', { type: 'oauth', grant: 'device_code', clientId: 'a', clientSecret: 'b' }, cfg), /grant/);
    assert.throws(() => normalizeCustomMcpAuth('s', { type: 'magic' }, cfg), /type/);
});

test('duplicate names are skipped', () => {
    const loaded = loadCustomMcpServers([
        { name: 'A', url: 'http://localhost/mcp', auth: { type: 'none' } },
        { name: 'A', url: 'http://localhost/other', auth: { type: 'none' } },
        { name: 'B', url: 'http://localhost/b', auth: { type: 'none' } },
    ], cfg);
    assert.equal(loaded.servers.length, 1);
    assert.equal(loaded.servers[0]?.name, 'B');
    assert.ok(loaded.skipped.some((e) => e.field === 'name'));
});

test('invalid server is isolated', () => {
    const loaded = loadCustomMcpServers([
        { name: 'good', url: 'http://localhost/mcp', auth: { type: 'none' } },
        { name: 'bad', url: 'not-a-url', auth: { type: 'none' } },
    ], cfg);
    assert.equal(loaded.servers.map((s) => s.name).join(','), 'good');
    assert.equal(loaded.skipped.length, 1);
    assert.equal(loaded.skipped[0]?.field, 'url');
});

test('redirect URI allowlist', () => {
    assert.equal(parseLoopbackRedirectUri('http://127.0.0.1:8765/callback').hostname, '127.0.0.1');
    const bad = [
        'http://localhost:8765/callback',
        'http://0.0.0.0:8765/callback',
        'http://192.168.1.50:8765/callback',
        'https://127.0.0.1:8765/callback',
        'http://127.0.0.1:8765/callback?x=1',
        'http://127.0.0.1:8765/callback#frag',
        'http://user:pass@127.0.0.1:8765/callback',
        'not-a-url',
        'http://[::1]:8765/callback',
        'http://127.0.0.1:8765/',
    ];
    for (const uri of bad) {
        assert.throws(() => parseLoopbackRedirectUri(uri, 's'), CustomMcpConfigError, uri);
    }
});

test('relative tokenStore is config-relative', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    const path = join(dir, 'config.yaml');
    await writeFile(path, 'x: 1\n');
    const auth = normalizeCustomMcpAuth('s', {
        type: 'oauth',
        grant: 'authorization_code',
        clientId: 'id',
        tokenStore: 'tokens/a.json',
    }, path);
    if (auth.type === 'oauth' && auth.grant === 'authorization_code') {
        assert.equal(auth.tokenStore, join(dir, 'tokens/a.json'));
    }
});
