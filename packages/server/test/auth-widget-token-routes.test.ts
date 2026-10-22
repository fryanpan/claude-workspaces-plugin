/**
 * The widget board token routes: an app-page embed borrows the identity a
 * browser proved to the workspace origin, as a board token (`wt2`) for one
 * board, one page origin and one day, and nothing more.
 *
 * The load-bearing security claims each get a test in BOTH directions:
 * a live session's token attributes comments (positive control), and the
 * same token is refused — not silently downgraded — after the session is
 * revoked, whether by logout (denylist) or by the roster watermark, or when
 * presented from any origin but the one it was minted for.
 */
import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { emailIdentityId } from '@claude-workspaces/core';
import { widgetTokenKey } from '../src/auth/widget-token.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import {
  DEV_ORIGIN,
  bearer,
  boot,
  commentRows,
  mintToken,
  postComment,
  signIn,
  signInAndMint,
  stopServersAfterEach,
} from './auth-widget-token-harness.ts';

stopServersAfterEach();
describe('POST /api/auth/widget-token', () => {
  it('refuses without a signed-in session', async () => {
    const { base, ws } = boot();
    const res = await mintToken(base, null, ws);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not_signed_in' });
  });

  it('mints for an allowed dev-server origin and names the user', async () => {
    const { base, ws } = boot();
    const cookie = await signIn(base, 'reviewer@example.com');
    const res = await mintToken(base, cookie, ws);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      token: string;
      origin: string;
      user: { id: string };
    };
    expect(body.ok).toBe(true);
    expect(body.origin).toBe(DEV_ORIGIN);
    expect(body.user.id).toBe(emailIdentityId('reviewer@example.com'));
    // A board token for this board, tied to the session — never the
    // retired seven-day wt1, and never the cookie itself.
    expect(body.token.startsWith('wt2.')).toBe(true);
    expect(body.token.split('.')[4]).toBe(Buffer.from(ws).toString('base64url'));
    expect((cookie.split('=')[1] ?? '').includes(body.token)).toBe(false);
  });

  it('refuses a board this server does not hold, or none at all', async () => {
    const { base } = boot();
    const cookie = await signIn(base, 'reviewer@example.com');
    for (const workspaceId of ['w-nosuch', '']) {
      const res = await mintToken(base, cookie, workspaceId);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'unknown_workspace' });
    }
  });

  it('refuses an origin the widget policy does not allow', async () => {
    // The popup would postMessage the token TO this origin; refusing here is
    // what keeps a malicious page from naming itself the recipient.
    const { base, ws } = boot();
    const cookie = await signIn(base, 'reviewer@example.com');
    const res = await mintToken(base, cookie, ws, 'https://evil.example.com');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin_not_allowed' });
  });

  it('refuses a cross-origin caller — minting is the popup page’s alone', async () => {
    const { base, ws } = boot();
    const cookie = await signIn(base, 'reviewer@example.com');
    // A dev-server page calling the mint route directly: its Origin header
    // names the dev server, not us. (Its fetch could not carry the SameSite
    // cookie anyway.) Carrying the cookie, it now meets the chain's
    // cross-origin credential refusal before the route's own same-origin one.
    const res = await mintToken(base, cookie, ws, DEV_ORIGIN, { origin: DEV_ORIGIN });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('cross_origin_credentials');
  });
});

describe('GET /api/auth/widget-session', () => {
  it('answers not-authenticated with no token', async () => {
    const { base } = boot();
    const res = await fetch(`${base}/api/auth/widget-session`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it('names the user for a live token', async () => {
    const { base, ws } = boot();
    const { token } = await signInAndMint(base, 'reviewer@example.com', ws);
    const res = await fetch(`${base}/api/auth/widget-session`, {
      headers: bearer(token),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      authenticated: true,
      user: { id: emailIdentityId('reviewer@example.com') },
    });
  });

  it('401s a token that does not verify', async () => {
    const { base } = boot();
    const res = await fetch(`${base}/api/auth/widget-session`, {
      headers: { authorization: 'Bearer wt1.user-x.sid.1.99999999999999.forged' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'widget_token_invalid' });
  });

  it('ignores an Authorization header that is not a widget token', async () => {
    const { base } = boot();
    const res = await fetch(`${base}/api/auth/widget-session`, {
      headers: { authorization: 'Bearer something-else-entirely' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });
});

describe('comment attribution', () => {
  it('attributes a token-carrying comment to the verified identity, flag off', async () => {
    // Presenting the token is itself the opt-in: unlike the cookie rung
    // (which stays behind CW_REQUIRE_EMAIL_AUTH), a caller who volunteers a
    // verified token gets the verified attribution today.
    const { base, dataDir, ws } = boot();
    const { token } = await signInAndMint(base, 'reviewer@example.com', ws);
    const res = await postComment(base, dataDir, ws, 'token-doc', token);
    expect(res.status).toBe(200);
    const [row] = commentRows(dataDir);
    expect(row?.actorId).toBe(emailIdentityId('reviewer@example.com'));
    expect(row?.actorName).toBe('Reviewer');
  });

  it('control: the same comment with no token stays the claimed body', async () => {
    const { base, dataDir, ws } = boot();
    await signInAndMint(base, 'reviewer@example.com', ws);
    const res = await postComment(base, dataDir, ws, 'anon-doc');
    expect(res.status).toBe(200);
    expect(commentRows(dataDir)[0]?.actorId).toBe('known-bryan');
  });

  it('refuses — not downgrades — a comment carrying an invalid token', async () => {
    const { base, dataDir, ws } = boot();
    const res = await postComment(base, dataDir, ws, 'forged-doc', 'wt1.user-x.sid.1.9.forged');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'widget_token_invalid' });
    expect(commentRows(dataDir).length).toBe(0);
  });
});

describe('one board', () => {
  it('attributes on its own board and refuses another board on the same server', async () => {
    const { base, dataDir, handle, ws } = boot();
    const other = handle.tasks.createWorkspace('Saltmarsh').id;
    const { token } = await signInAndMint(base, 'reviewer@example.com', ws);
    const elsewhere = await postComment(base, dataDir, other, 'other-board-doc', token);
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toEqual({ error: 'out_of_widget_scope' });
    expect(commentRows(dataDir).length).toBe(0);
    // Control: the same token on its own board.
    expect((await postComment(base, dataDir, ws, 'own-board-doc', token)).status).toBe(200);
  });
});

describe('the retired seven-day token', () => {
  it('refuses a genuine wt1 that a browser still holds, so the widget signs in again', async () => {
    const { base, dataDir, ws } = boot();
    await signIn(base, 'reviewer@example.com');
    // Signed with this server's own key, exactly as the old mint did.
    const payload = [
      'wt1',
      emailIdentityId('reviewer@example.com'),
      'sid-abc123',
      Date.now(),
      Date.now() + 60_000,
      Buffer.from(DEV_ORIGIN).toString('base64url'),
    ].join('.');
    const mac = createHmac('sha256', widgetTokenKey(loadCookieKey(dataDir)))
      .update(payload)
      .digest('base64url');
    const wt1 = `${payload}.${mac}`;
    const probe = await fetch(`${base}/api/auth/widget-session`, { headers: bearer(wt1) });
    expect(probe.status).toBe(401);
    expect(await probe.json()).toEqual({ error: 'widget_token_invalid' });
    expect((await postComment(base, dataDir, ws, 'wt1-doc', wt1)).status).toBe(401);
    expect(commentRows(dataDir).length).toBe(0);
  });
});

describe('the token is bound to the origin it was minted for', () => {
  // The mint route hands the token to one server-validated page origin, and
  // every use must come from that page: the browser stamps Origin on each
  // cross-origin fetch the widget makes, and nothing else can forge it. A
  // token lifted out of a dev server's localStorage is worthless from curl,
  // from another origin, or from an opaque (`null`) one.
  it('accepts the token from the origin it was minted for (positive control)', async () => {
    const { base, dataDir, ws } = boot();
    const { token } = await signInAndMint(base, 'reviewer@example.com', ws);
    const probe = await fetch(`${base}/api/auth/widget-session`, {
      headers: bearer(token, DEV_ORIGIN),
    });
    expect(probe.status).toBe(200);
    expect(((await probe.json()) as { authenticated: boolean }).authenticated).toBe(true);
    const write = await postComment(base, dataDir, ws, 'bound-doc', token, DEV_ORIGIN);
    expect(write.status).toBe(200);
    expect(commentRows(dataDir)[0]?.actorId).toBe(emailIdentityId('reviewer@example.com'));
  });

  it.each([
    ['another allowed origin', 'http://localhost:3000'],
    ['no Origin header at all (curl, a server-side replay)', null],
    ['an opaque origin', 'null'],
  ])('refuses the token presented from %s', async (_label, origin) => {
    const { base, dataDir, ws } = boot();
    const { token } = await signInAndMint(base, 'reviewer@example.com', ws);
    const probe = await fetch(`${base}/api/auth/widget-session`, {
      headers: bearer(token, origin),
    });
    expect(probe.status).toBe(401);
    expect(await probe.json()).toEqual({ error: 'widget_token_invalid' });
    const write = await postComment(base, dataDir, ws, 'unbound-doc', token, origin);
    // An opaque-origin write is refused one wall earlier, by the browser-
    // origin policy (403); the probe above is what pins the token gate.
    expect([401, 403]).toContain(write.status);
    expect(commentRows(dataDir).length).toBe(0);
  });
});

describe('the token is narrower than the session', () => {
  it('does not make /api/auth/session report signed-in', async () => {
    const { base, ws } = boot();
    const { token } = await signInAndMint(base, 'reviewer@example.com', ws);
    const res = await fetch(`${base}/api/auth/session`, {
      headers: bearer(token),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });
});

describe('GET /widget-auth (the popup page)', () => {
  it('serves the handshake page, never inside a frame', async () => {
    const { base } = boot();
    const res = await fetch(`${base}/widget-auth`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    // Framing would let a same-site page mint silently, with no visible
    // popup. The flow is popup-only.
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
