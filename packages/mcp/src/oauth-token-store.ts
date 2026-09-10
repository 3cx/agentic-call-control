import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthTokensSchema, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

export const TOKEN_STORE_VERSION = 1;

export interface TokenStoreFile {
    version: number;
    tokens?: OAuthTokens;
    codeVerifier?: string;
    expectedState?: string;
    discovery?: OAuthDiscoveryState;
}

export class TokenStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TokenStoreError';
    }
}

export class TokenStoreLockError extends TokenStoreError {
    readonly storePath: string;

    constructor(storePath: string) {
        super(`Token store is locked by another process: ${storePath}`);
        this.name = 'TokenStoreLockError';
        this.storePath = storePath;
    }
}

function lockPathFor(storePath: string): string {
    return `${storePath}.lock`;
}

function pidIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

async function stealStaleLock(lockPath: string): Promise<boolean> {
    let pidText: string;
    try {
        pidText = (await readFile(lockPath, 'utf8')).trim();
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT';
    }
    const pid = Number.parseInt(pidText, 10);
    if (Number.isInteger(pid) && pid > 0 && pidIsAlive(pid)) {
        return false;
    }
    try {
        await unlink(lockPath);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT';
    }
}

export class TokenStoreLock {
    private released = false;
    private readonly lockPath: string;
    private readonly handle: Awaited<ReturnType<typeof open>>;

    private constructor(lockPath: string, handle: Awaited<ReturnType<typeof open>>) {
        this.lockPath = lockPath;
        this.handle = handle;
    }

    static async acquire(storePath: string): Promise<TokenStoreLock> {
        const lockPath = lockPathFor(storePath);
        await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
        try {
            await chmod(dirname(storePath), 0o700);
        } catch {
            // best-effort on existing dirs we don't own
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const handle = await open(lockPath, 'wx', 0o600);
                await handle.writeFile(`${process.pid}\n`, { encoding: 'utf8' });
                return new TokenStoreLock(lockPath, handle);
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code !== 'EEXIST') throw err;
                if (attempt === 0 && await stealStaleLock(lockPath)) continue;
                throw new TokenStoreLockError(storePath);
            }
        }
        throw new TokenStoreLockError(storePath);
    }

    async release(): Promise<void> {
        if (this.released) return;
        this.released = true;
        try {
            await this.handle.close();
        } catch {
            // ignore
        }
        try {
            await unlink(this.lockPath);
        } catch {
            // ignore
        }
    }
}

function parseStore(raw: string): TokenStoreFile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new TokenStoreError('malformed token store');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TokenStoreError('malformed token store');
    }
    const rec = parsed as Record<string, unknown>;
    const allowedFields = new Set(['version', 'tokens', 'codeVerifier', 'expectedState', 'discovery']);
    if (Object.keys(rec).some((field) => !allowedFields.has(field))) {
        throw new TokenStoreError('malformed token store');
    }
    if (rec.version !== TOKEN_STORE_VERSION) {
        throw new TokenStoreError('unsupported token store version');
    }
    const store: TokenStoreFile = { version: TOKEN_STORE_VERSION };
    if (rec.tokens !== undefined) {
        const result = OAuthTokensSchema.safeParse(rec.tokens);
        if (!result.success) {
            throw new TokenStoreError('malformed token store');
        }
        store.tokens = result.data;
    }
    if (rec.codeVerifier !== undefined) {
        if (typeof rec.codeVerifier !== 'string') throw new TokenStoreError('malformed token store');
        store.codeVerifier = rec.codeVerifier;
    }
    if (rec.expectedState !== undefined) {
        if (typeof rec.expectedState !== 'string') throw new TokenStoreError('malformed token store');
        store.expectedState = rec.expectedState;
    }
    if (rec.discovery !== undefined) {
        if (!rec.discovery || typeof rec.discovery !== 'object') {
            throw new TokenStoreError('malformed token store');
        }
        store.discovery = rec.discovery as OAuthDiscoveryState;
    }
    return store;
}

export class FileTokenStore {
    readonly path: string;

    constructor(path: string) {
        this.path = path;
    }

    async assertWritableTarget(): Promise<void> {
        try {
            const st = await lstat(this.path);
            if (st.isDirectory()) {
                throw new TokenStoreError('token store path is a directory');
            }
            if (st.isSymbolicLink()) {
                throw new TokenStoreError('token store path is a symbolic link');
            }
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw err;
        }
    }

    async read(): Promise<TokenStoreFile | undefined> {
        try {
            const st = await lstat(this.path);
            if (st.isDirectory() || st.isSymbolicLink()) {
                throw new TokenStoreError('token store path is not a regular file');
            }
            const raw = await readFile(this.path, 'utf8');
            return parseStore(raw);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            if (err instanceof TokenStoreError) throw err;
            throw new TokenStoreError('unreadable token store');
        }
    }

    async write(data: TokenStoreFile): Promise<void> {
        await this.assertWritableTarget();
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        try {
            await chmod(dirname(this.path), 0o700);
        } catch {
            // best-effort
        }

        const tmp = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
        const fd = openSync(tmp, 'wx', 0o600);
        try {
            const payload = `${JSON.stringify({ ...data, version: TOKEN_STORE_VERSION }, null, 2)}\n`;
            writeSync(fd, payload, 0, 'utf8');
            fsyncSync(fd);
        } catch (err) {
            try { closeSync(fd); } catch { /* ignore */ }
            try { unlinkSync(tmp); } catch { /* ignore */ }
            throw err;
        }
        closeSync(fd);
        try {
            await chmod(tmp, 0o600);
            this.renameTempFile(tmp);
        } catch (err) {
            try { unlinkSync(tmp); } catch { /* ignore */ }
            throw err;
        }
    }

    protected renameTempFile(tmp: string): void {
        renameSync(tmp, this.path);
    }

    async update(mutator: (current: TokenStoreFile) => TokenStoreFile): Promise<TokenStoreFile> {
        const current = (await this.read()) ?? { version: TOKEN_STORE_VERSION };
        const next = mutator(current);
        await this.write(next);
        return next;
    }
}

export async function pathIsSymlink(target: string): Promise<boolean> {
    try {
        const st = await lstat(target);
        return st.isSymbolicLink();
    } catch {
        return false;
    }
}

export async function resolveRealParent(storePath: string): Promise<string> {
    try {
        return await realpath(dirname(storePath));
    } catch {
        return dirname(storePath);
    }
}
