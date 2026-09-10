import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { test } from 'node:test';
import { FileTokenStore, TOKEN_STORE_VERSION, TokenStoreError, TokenStoreLock } from '../src/oauth-token-store.ts';

test('atomic write creates 0600 file and 0700 parent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-store-'));
    const path = join(dir, 'tokens', 'a.json');
    const store = new FileTokenStore(path);
    await store.write({
        version: TOKEN_STORE_VERSION,
        tokens: { access_token: 'a', token_type: 'Bearer' },
    });
    const raw = JSON.parse(await readFile(path, 'utf8')) as { tokens: { access_token: string } };
    assert.equal(raw.tokens.access_token, 'a');
    const { stat } = await import('node:fs/promises');
    const fileMode = (await stat(path)).mode & 0o777;
    assert.equal(fileMode, 0o600);
    const parentMode = (await stat(dirname(path))).mode & 0o777;
    assert.equal(parentMode, 0o700);
});

test('malformed and unsupported version are unusable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-store-'));
    const path = join(dir, 'a.json');
    await writeFile(path, '{not json', { mode: 0o600 });
    const store = new FileTokenStore(path);
    await assert.rejects(() => store.read(), TokenStoreError);

    await writeFile(path, JSON.stringify({ version: 99, tokens: { access_token: 'a', token_type: 'Bearer' } }), { mode: 0o600 });
    await assert.rejects(() => store.read(), /unsupported/);

    await writeFile(path, JSON.stringify({ version: 1, unexpected: true }), { mode: 0o600 });
    await assert.rejects(() => store.read(), /malformed/);

    await writeFile(path, JSON.stringify({
        version: 1,
        tokens: { access_token: 'a', token_type: 'Bearer', expires_in: 'not-a-number' },
    }), { mode: 0o600 });
    await assert.rejects(() => store.read(), /malformed/);
});

test('symlink and directory targets are refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-store-'));
    const real = join(dir, 'real.json');
    await writeFile(real, JSON.stringify({ version: 1 }), { mode: 0o600 });
    const link = join(dir, 'link.json');
    await symlink(real, link);
    await assert.rejects(() => new FileTokenStore(link).write({ version: 1 }), /symbolic link/);

    const asDir = join(dir, 'asdir');
    await mkdir(asDir);
    await assert.rejects(() => new FileTokenStore(asDir).write({ version: 1 }), /directory/);
});

test('successful write leaves no tmp siblings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-store-'));
    const path = join(dir, 'a.json');
    const store = new FileTokenStore(path);
    await store.write({ version: 1, tokens: { access_token: 'keep', token_type: 'Bearer' } });
    const names = await (await import('node:fs/promises')).readdir(dir);
    assert.deepEqual(names.filter((n) => n.includes('.tmp')), []);
    assert.equal((await store.read())?.tokens?.access_token, 'keep');
});

test('atomic rename failure preserves the previous valid store', async () => {
    class FailingRenameStore extends FileTokenStore {
        protected override renameTempFile(): void {
            throw new Error('simulated rename failure');
        }
    }

    const dir = await mkdtemp(join(tmpdir(), 'mcp-store-'));
    const path = join(dir, 'a.json');
    const original = new FileTokenStore(path);
    await original.write({ version: 1, tokens: { access_token: 'keep', token_type: 'Bearer' } });

    const failing = new FailingRenameStore(path);
    await assert.rejects(() => failing.write({
        version: 1,
        tokens: { access_token: 'replacement', token_type: 'Bearer' },
    }), /simulated rename failure/);
    assert.equal((await original.read())?.tokens?.access_token, 'keep');
    const names = await (await import('node:fs/promises')).readdir(dir);
    assert.deepEqual(names.filter((name) => name.includes('.tmp')), []);
});

test('exclusive lock rejects a second writer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-store-'));
    const path = join(dir, 'a.json');
    const first = await TokenStoreLock.acquire(path);
    await assert.rejects(() => TokenStoreLock.acquire(path), /locked/);
    await first.release();
    const second = await TokenStoreLock.acquire(path);
    await second.release();
});

test('stale lock from a dead pid is stolen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-store-'));
    const path = join(dir, 'a.json');
    await writeFile(`${path}.lock`, '2147483647\n', { mode: 0o600 });
    const lock = await TokenStoreLock.acquire(path);
    await lock.release();
});
