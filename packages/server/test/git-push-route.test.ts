/**
 * A lead's push through its board server (`routes/git-push.ts`,
 * `git-push/pusher.ts`), against local bare repositories standing in for
 * GitHub and a fake credential.
 *
 * - Line 1: a listed repo's feature branch lands upstream; an unlisted repo,
 *   the default branch and a force-push are refused, and upstream is unchanged.
 * - Line 2: the same request over a board's own socket, as a walled lead on
 *   the Mac sends it, and on a server configured as a project machine is (the
 *   lead's uid refused on loopback TCP), where only the socket works.
 * - Line 3, the server's half: the credential reaches git only through the
 *   child's environment, never an argument, and no answer the lead can get
 *   carries it, even when upstream fails.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GIT_PUSH_POLICY_FILE } from '../src/git-push/policy.ts';
import { FAKE_TOKEN, type PushWorld, pushPath, startPushWorld } from './git-push-fixture.ts';

const policy = (board: string) => ({
  boards: { [board]: { repos: [{ repo: 'Harborlight/notes' }] } },
});

const post = (body: Uint8Array) => ({ method: 'POST', body });

describe('a lead on the Mac pushes over its board socket', () => {
  let w: PushWorld;
  beforeAll(async () => {
    w = await startPushWorld(policy);
  });
  afterAll(() => w.stop());

  it('pushes a listed repo’s feature branch', async () => {
    const res = await w.onSocket(
      pushPath(w.board, 'Harborlight/notes', 'feature-a'),
      post(w.leadBundle('Harborlight/notes', 'feature-a')),
    );
    const body = (await res.json()) as { state: string; sha: string; id: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.state).toBe('pushed');
    expect(w.upstreamTip('Harborlight/notes', 'feature-a')).toBe(body.sha);

    const status = await w.onSocket(`/workspaces/${w.board}/git/pushes/${body.id}`);
    expect(((await status.json()) as { state: string }).state).toBe('pushed');
  });

  it('fast-forwards a branch that already exists upstream', async () => {
    const first = await w.onSocket(
      pushPath(w.board, 'Harborlight/notes', 'feature-ff'),
      post(w.leadBundle('Harborlight/notes', 'feature-ff')),
    );
    expect(first.status).toBe(200);
    const next = await w.onSocket(
      pushPath(w.board, 'Harborlight/notes', 'feature-ff'),
      post(w.leadBundle('Harborlight/notes', 'feature-ff', { from: 'origin/feature-ff' })),
    );
    const body = (await next.json()) as { state: string; sha: string };
    expect(next.status, JSON.stringify(body)).toBe(200);
    expect(w.upstreamTip('Harborlight/notes', 'feature-ff')).toBe(body.sha);
  });

  it('refuses a repo that is not on the board’s list, and upstream is unchanged', async () => {
    const res = await w.onSocket(
      pushPath(w.board, 'Riverbend/notes', 'feature-b'),
      post(w.leadBundle('Riverbend/notes', 'feature-b')),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('repo-not-listed');
    expect(w.upstreamTip('Riverbend/notes', 'feature-b')).toBe('');
  });

  it('refuses the default branch, and upstream is unchanged', async () => {
    const before = w.upstreamTip('Harborlight/notes', 'main');
    const res = await w.onSocket(
      pushPath(w.board, 'Harborlight/notes', 'main'),
      post(w.leadBundle('Harborlight/notes', 'main-copy')),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('default-branch');
    expect(w.upstreamTip('Harborlight/notes', 'main')).toBe(before);
  });

  it('refuses a force-push, and upstream is unchanged', async () => {
    const first = await w.onSocket(
      pushPath(w.board, 'Harborlight/notes', 'feature-force'),
      post(w.leadBundle('Harborlight/notes', 'feature-force')),
    );
    expect(first.status).toBe(200);
    const tip = w.upstreamTip('Harborlight/notes', 'feature-force');
    // A rewrite: the new tip starts again from main and drops the pushed commit.
    const res = await w.onSocket(
      pushPath(w.board, 'Harborlight/notes', 'feature-force'),
      post(w.leadBundle('Harborlight/notes', 'feature-force', { rewrite: true })),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('not-fast-forward');
    expect(w.upstreamTip('Harborlight/notes', 'feature-force')).toBe(tip);
  });

  it('never passes the credential as an argument, only in git’s environment', () => {
    const pushes = w.calls.filter((c) => c.args.includes('push'));
    expect(pushes.length).toBeGreaterThan(0);
    for (const c of w.calls) expect(c.args.join(' ')).not.toContain(FAKE_TOKEN);
    for (const c of pushes) {
      expect(c.args.some((a) => a.includes('--force') || a.startsWith('+'))).toBe(false);
      expect(Object.values(c.env).join('\n')).toContain(
        Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString('base64'),
      );
    }
  });

  it('refuses another board’s path on this socket, and a browser over TCP', async () => {
    const other = await w.overTcp('/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Riverbend' }),
    });
    const riverbend = ((await other.json()) as { workspace: { id: string } }).workspace.id;
    const bundle = w.leadBundle('Harborlight/notes', 'feature-cross');
    const cross = await w.onSocket(
      pushPath(riverbend, 'Harborlight/notes', 'feature-cross'),
      post(bundle),
    );
    expect(cross.status).toBe(403);
    const browser = await w.overTcp(pushPath(w.board, 'Harborlight/notes', 'feature-cross'), {
      ...post(bundle),
      headers: { 'sec-fetch-mode': 'cors', origin: w.base },
    });
    // Refused before the route: a browser write with no sign-in is 401.
    expect([401, 403]).toContain(browser.status);
    const edge = await w.overTcp(pushPath(w.board, 'Harborlight/notes', 'feature-cross'), {
      ...post(bundle),
      headers: { 'cf-ray': 'test' },
    });
    expect(edge.status).toBe(403);
    expect(w.upstreamTip('Harborlight/notes', 'feature-cross')).toBe('');
  });

  it('keeps the credential out of every answer when upstream fails', async () => {
    // Point the list at a repo upstream does not have, so git's own error comes back.
    writeFileSync(
      join(w.dataDir, GIT_PUSH_POLICY_FILE),
      JSON.stringify({
        boards: {
          [w.board]: { repos: [{ repo: 'Harborlight/notes' }, { repo: 'Harborlight/missing' }] },
        },
      }),
    );
    const bundle = w.leadBundle('Harborlight/notes', 'feature-missing');
    const res = await w.onSocket(
      pushPath(w.board, 'Harborlight/missing', 'feature-missing'),
      post(bundle),
    );
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString('base64'));
    const id = (JSON.parse(text) as { id: string }).id;
    const status = await (await w.onSocket(`/workspaces/${w.board}/git/pushes/${id}`)).text();
    expect(status).not.toContain(FAKE_TOKEN);
  });
});

describe('a lead on a project machine pushes over its board socket, never loopback TCP', () => {
  let w: PushWorld;
  const LEAD_UID = 4242;
  const OPERATOR_UID = 4243;
  let peer = OPERATOR_UID;
  beforeAll(async () => {
    // As on Fly: the lead's uid is refused on loopback TCP. The board is made
    // by another uid first, as the machine's deploy makes it.
    w = await startPushWorld(policy, { loopbackRefusedUids: [LEAD_UID], peerUid: () => peer });
    peer = LEAD_UID;
  });
  afterAll(() => w.stop());

  it('is refused over loopback TCP and pushes over the socket', async () => {
    const bundle = w.leadBundle('Harborlight/notes', 'feature-fly');
    const tcp = await w.overTcp(
      pushPath(w.board, 'Harborlight/notes', 'feature-fly'),
      post(bundle),
    );
    expect(tcp.status).toBe(403);
    expect(w.upstreamTip('Harborlight/notes', 'feature-fly')).toBe('');

    const res = await w.onSocket(
      pushPath(w.board, 'Harborlight/notes', 'feature-fly'),
      post(bundle),
    );
    const body = (await res.json()) as { state: string; sha: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(w.upstreamTip('Harborlight/notes', 'feature-fly')).toBe(body.sha);
  });
});
