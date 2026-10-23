/**
 * A widget board token dies with what proved it: logout, the roster
 * watermark, a denylist that cannot be read, an archived identity. Each
 * refusal has its positive control, the same token working first.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailIdentityId } from '@claude-workspaces/core';
import { createServer } from '../src/server.ts';
import {
  bearer,
  boot,
  cleanups,
  commentRows,
  postComment,
  signInAndMint,
  stopServersAfterEach,
} from './auth-widget-token-harness.ts';
import { waitFor } from './wait-for.ts';

stopServersAfterEach();

describe('revocation kills the token', () => {
  it('logout revokes the session, and the token dies with it', async () => {
    const { base, dataDir, ws } = boot();
    const { cookie, token } = await signInAndMint(base, 'reviewer@example.com', ws);

    // Positive control first: the token works while the session lives.
    const alive = await fetch(`${base}/api/auth/widget-session`, {
      headers: bearer(token),
    });
    expect(((await alive.json()) as { authenticated: boolean }).authenticated).toBe(true);

    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(200);

    const dead = await fetch(`${base}/api/auth/widget-session`, {
      headers: bearer(token),
    });
    expect(dead.status).toBe(401);
    // And a write is refused outright, not attributed to anyone.
    const write = await postComment(base, dataDir, ws, 'revoked-doc', token);
    expect(write.status).toBe(401);
    expect(commentRows(dataDir).length).toBe(0);
  });

  it('the roster watermark (denylist self-heal) refuses tokens minted before it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'widget-token-watermark-'));
    const first = boot({ dataDir });
    const { token } = await signInAndMint(first.base, 'reviewer@example.com', first.ws);
    const mintedAt = Date.now();
    await first.handle.stop();

    // The watermark ends what was minted STRICTLY before it, so the token and
    // the second boot must not land in the same millisecond. Nothing stopped
    // them: the whole test runs in under 10ms, and the collision handed the
    // token a 200 in roughly one full-suite run in three. Wait for the clock
    // to leave the mint's millisecond — an event, not a debounce, so there is
    // no cadence to derive a duration from.
    await waitFor(() => Date.now() > mintedAt || false, {
      interval: 1,
      describe: 'the clock to advance past the millisecond the token was minted in',
    });

    // A corrupt denylist at boot fails closed, ends every session via the
    // sessionsValidFrom watermark, and restarts the list empty. A widget
    // token minted from a pre-bump session must die with it.
    writeFileSync(join(dataDir, 'revoked-sessions.json'), 'not json{');
    const second = createServer({ port: 0, dataDir, emailCodeSignIn: true });
    cleanups.push(async () => {
      await second.stop();
    });
    const base = `http://127.0.0.1:${second.port}`;
    const res = await fetch(`${base}/api/auth/widget-session`, {
      headers: bearer(token),
    });
    expect(res.status).toBe(401);
  });
});

describe('the denylist failing closed at runtime', () => {
  it('refuses every token once the denylist is deleted out from under a running server', async () => {
    // Boot-time corruption is covered by the watermark test above; this is
    // the OTHER failed-closed path — the file vanishing while the server
    // runs — which no watermark bump heals. With the list gone nothing can
    // tell a live session from a logged-out one, so every token reads as
    // revoked. Load-bearing check: `isRevoked` itself answers true while
    // failed closed; the explicit `failedClosed()` guard ahead of it in
    // boardWidgetGrantFor is belt-and-braces.
    const { base, dataDir, ws } = boot();
    const { token } = await signInAndMint(base, 'reviewer@example.com', ws);
    const alive = await fetch(`${base}/api/auth/widget-session`, { headers: bearer(token) });
    expect(alive.status).toBe(200);

    rmSync(join(dataDir, 'revoked-sessions.json'));

    const dead = await fetch(`${base}/api/auth/widget-session`, { headers: bearer(token) });
    expect(dead.status).toBe(401);
    const write = await postComment(base, dataDir, ws, 'denylist-gone-doc', token);
    expect(write.status).toBe(401);
    expect(commentRows(dataDir).length).toBe(0);
  });
});

describe('an archived identity', () => {
  it('cannot use its token, even when the row carries no session watermark', async () => {
    // `archive()` bumps sessionsValidFrom, so through the API the watermark
    // alone would refuse the token. The roster is also a file people edit:
    // a row hand-marked `archived` with its watermark left at 0 is exactly
    // the case the status check catches on its own. Remove that check and
    // this token works again.
    const dataDir = mkdtempSync(join(tmpdir(), 'widget-token-archived-'));
    const first = boot({ dataDir });
    const { token } = await signInAndMint(first.base, 'reviewer@example.com', first.ws);
    const alive = await fetch(`${first.base}/api/auth/widget-session`, {
      headers: bearer(token),
    });
    expect(alive.status).toBe(200);
    await first.handle.stop();

    const rosterPath = join(dataDir, 'identities.json');
    const roster = JSON.parse(readFileSync(rosterPath, 'utf8')) as {
      identities: Record<string, { status: string; sessionsValidFrom: number }>;
    };
    const row = roster.identities[emailIdentityId('reviewer@example.com')];
    expect(row).toBeTruthy();
    (row as { status: string }).status = 'archived';
    (row as { sessionsValidFrom: number }).sessionsValidFrom = 0;
    writeFileSync(rosterPath, JSON.stringify(roster));

    const second = createServer({ port: 0, dataDir, emailCodeSignIn: true });
    cleanups.push(async () => {
      await second.stop();
    });
    const base = `http://127.0.0.1:${second.port}`;
    const res = await fetch(`${base}/api/auth/widget-session`, { headers: bearer(token) });
    expect(res.status).toBe(401);
  });
});
