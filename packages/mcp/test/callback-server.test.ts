import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
    OAuthCallbackError,
    parsePastedCallbackUrl,
    startLoopbackCallback,
    validateCallbackSearchParams,
} from '../src/oauth-callback-server.ts';

const state = 'abc123abc123abc123abc123abc123ab';

test('validates state, code, issuer, and rejects bare code paste', () => {
    const ok = validateCallbackSearchParams({
        params: new URLSearchParams({ code: 'c', state, iss: 'http://as.example' }),
        expectedState: state,
        expectedIssuer: 'http://as.example',
        issuerRequired: true,
    });
    assert.equal(ok.code, 'c');

    assert.throws(() => validateCallbackSearchParams({
        params: new URLSearchParams({ code: 'c' }),
        expectedState: state,
        issuerRequired: false,
    }), /state/i);

    assert.throws(() => validateCallbackSearchParams({
        params: new URLSearchParams({ code: 'c', state: 'nope', iss: 'http://as.example' }),
        expectedState: state,
        issuerRequired: false,
    }), /state/i);

    assert.throws(() => validateCallbackSearchParams({
        params: new URLSearchParams({ code: 'c', state, iss: 'http://other' }),
        expectedState: state,
        expectedIssuer: 'http://as.example',
        issuerRequired: false,
    }), /Issuer/);

    assert.throws(() => validateCallbackSearchParams({
        params: new URLSearchParams({ error: 'access_denied', state }),
        expectedState: state,
        issuerRequired: false,
    }), /denied/i);

    assert.throws(
        () => parsePastedCallbackUrl('only-a-code', new URL('http://127.0.0.1:8765/callback')),
        OAuthCallbackError,
    );
});

test('loopback listener accepts one GET callback and rejects replay', async () => {
    const listener = startLoopbackCallback({
        redirectUri: 'http://127.0.0.1:18765/callback',
        expectedState: state,
        timeoutMs: 5000,
    });
    await listener.ready();
    const wait = listener.wait();
    const res = await fetch(`http://127.0.0.1:18765/callback?code=thecode&state=${state}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = await res.text();
    assert.doesNotMatch(html, /thecode/);
    assert.doesNotMatch(html, new RegExp(state));
    const result = await wait;
    assert.equal(result.code, 'thecode');
});

test('wrong method and path fail closed', async () => {
    const listener = startLoopbackCallback({
        redirectUri: 'http://127.0.0.1:18766/callback',
        expectedState: state,
        timeoutMs: 2000,
    });
    await listener.ready();
    const post = await fetch('http://127.0.0.1:18766/callback?code=c&state=' + state, { method: 'POST' });
    assert.equal(post.status, 405);
    const wrong = await fetch('http://127.0.0.1:18766/other?code=c&state=' + state);
    assert.equal(wrong.status, 404);
    await listener.close();
});

test('timeout and occupied port fail', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(18767, '127.0.0.1', () => resolve()));
    const occupied = startLoopbackCallback({
        redirectUri: 'http://127.0.0.1:18767/callback',
        expectedState: state,
        timeoutMs: 500,
    });
    await assert.rejects(() => occupied.ready());
    blocker.close();

    const listener = startLoopbackCallback({
        redirectUri: 'http://127.0.0.1:18768/callback',
        expectedState: state,
        timeoutMs: 50,
    });
    await listener.ready();
    await assert.rejects(() => listener.wait(), /timed out/i);
});
