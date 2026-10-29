/**
 * `POST /api/share/enabled` with and without a board: one board closes and
 * nothing else moves, and every flip of either kind writes the line that says
 * who, from where, when and why.
 *
 * The 23 September outage was a call that named a board and threw the master
 * switch, which refused every outside hostname including the owner's own.
 * So the board cases assert what did NOT change as carefully as what did: the
 * master switch stays on, the other board still answers its member, and the
 * owner's own hostname still reaches the closed board. Every refusal is paired
 * with the same request succeeding first.
 *
 * Built on the share-link configuration prod runs (a share hostname, the
 * owner's proxied hostname, the retired per-share registry alongside).
 */
import { beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { STAMP_PATTERN } from '../src/log-stamp.ts';
import {
  CF_RAY,
  LATE_MEMBER,
  MEMBER,
  OWNER_AUD,
  OWNER_EMAIL,
  OWNER_HOST,
  useSharingSwitchServer,
} from './sharing-switch-server.ts';

describe('the sharing switch, for one board and for all of them', () => {
  const f = useSharingSwitchServer();
  const {
    signJwt,
    req,
    postLocal,
    onShareHost,
    onOwnerHost,
    postOwner,
    turnBackOn,
    boardPath,
    status,
  } = f;
  let closing: string;
  let other: string;
  let closingLink: string;
  beforeAll(() => {
    ({ closing, other, closingLink } = f);
  });

  it('CONTROL: the member reaches both boards and the owner reaches its own hostname', async () => {
    expect((await onShareHost(boardPath(closing), MEMBER)).status).toBe(200);
    expect((await onShareHost(boardPath(other), MEMBER)).status).toBe(200);
    expect((await onOwnerHost(boardPath(closing))).status).toBe(200);
  });

  describe('with a workspaceId', () => {
    it('closes that board, echoes its id, and leaves the master switch on', async () => {
      const r = await postLocal('/api/share/enabled', {
        workspaceId: closing,
        enabled: false,
        reason: 'binding a sensitive folder',
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        ok: boolean;
        workspaceId: string;
        board: { workspaceId: string; enabled: boolean };
        sharing: { enabled: boolean; closedBoards?: string[] };
      };
      expect(body.ok).toBe(true);
      expect(body.workspaceId).toBe(closing);
      expect(body.board).toEqual({ workspaceId: closing, enabled: false });
      expect(body.sharing.enabled).toBe(true);
      expect(body.sharing.closedBoards).toEqual([closing]);
      expect((await status()).enabled).toBe(true);
    });

    it("refuses that board's member and nobody else", async () => {
      const shut = await onShareHost(boardPath(closing), MEMBER);
      expect(shut.status).toBe(403);
      expect(await shut.json()).toEqual({ error: 'sharing_disabled' });
      expect((await onShareHost(boardPath(other), MEMBER)).status).toBe(200);
    });

    it("never refuses the owner's own hostname, on the closed board or any other", async () => {
      expect((await onOwnerHost(boardPath(closing))).status).toBe(200);
      expect((await onOwnerHost(boardPath(other))).status).toBe(200);
    });

    it('admits nobody new through a link it already handed out', async () => {
      const r = await onShareHost(`/s/${closingLink}`, LATE_MEMBER);
      expect(r.status).toBe(404);
    });

    it('refuses a board that does not exist, and changes nothing', async () => {
      const r = await postLocal('/api/share/enabled', { workspaceId: 'w-nope', enabled: false });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'unknown_workspace', workspaceId: 'w-nope' });
      expect(await status()).toEqual({ enabled: true, locked: false, closedBoards: [closing] });
    });

    it("does not reopen it for an agent: that is the owner's, and needs a task for the card", async () => {
      const r = await postLocal('/api/share/enabled', { workspaceId: closing, enabled: true });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('task-required');
      expect((await status()).closedBoards).toEqual([closing]);
    });

    it("does not reopen it for the owner's cookie on a local dev server's page", async () => {
      // Same-site with this server, so the owner's cookie rides along. A page
      // may not change sharing at all (`browserCannotOperateBody`).
      const r = await req('/api/share/enabled', OWNER_HOST, {
        method: 'POST',
        headers: {
          ...CF_RAY,
          'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL),
          'content-type': 'application/json',
          'sec-fetch-site': 'same-site',
          origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ workspaceId: closing, enabled: true }),
      });
      expect(r.status).toBe(403);
      expect((await status()).closedBoards).toEqual([closing]);
    });

    it('reopens that board for the owner', async () => {
      const r = await postOwner('/api/share/enabled', { workspaceId: closing, enabled: true });
      expect(r.status).toBe(200);
      expect((await onShareHost(boardPath(closing), MEMBER)).status).toBe(200);
      expect(await status()).toEqual({ enabled: true, locked: false });
      // The link refused above redeems again: the refusal was the closed board.
      expect((await onShareHost(`/s/${closingLink}`, LATE_MEMBER)).status).toBe(302);
    });
  });

  it('refuses an argument it does not read, instead of answering ok without it', async () => {
    const r = await postLocal('/api/share/enabled', { board: closing, enabled: false });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain('board');
    expect(await status()).toEqual({ enabled: true, locked: false });
  });

  describe('the log line', () => {
    const flipLines = (spy: { mock: { calls: unknown[][] } }): string[] =>
      spy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((l: string) => l.includes('[sharing]'));

    it('names the actor, the peer, the time and the reason, for off and for on', async () => {
      const spy = spyOn(console, 'error');
      try {
        const off = await postLocal('/api/share/enabled', {
          enabled: false,
          reason: 'security review',
          actor: { id: 'agent-harborlight', name: 'Harborlight Agent' },
        });
        expect(off.status).toBe(200);
        // An agent cannot turn it back on, and a refusal writes no line.
        const refused = await postLocal('/api/share/enabled', { enabled: true });
        expect(refused.status).toBe(403);
        expect(flipLines(spy)).toHaveLength(1);
        await turnBackOn();
        const lines = flipLines(spy);
        expect(lines).toHaveLength(2);
        const [offLine, onLine] = lines as [string, string];
        expect(offLine).toMatch(STAMP_PATTERN);
        expect(offLine).toContain('master switch OFF');
        expect(offLine).toContain('"agent Harborlight Agent (agent-harborlight)"');
        expect(offLine).toMatch(/ from (::ffff:)?127\.0\.0\.1 /);
        expect(offLine).toContain('reason="security review"');
        expect(onLine).toMatch(STAMP_PATTERN);
        expect(onLine).toContain('master switch ON');
        expect(onLine).toContain('by "owner ');
        expect(onLine).toContain('the access door');
      } finally {
        spy.mockRestore();
      }
    });

    it('is written for a board flip too, naming the board', async () => {
      const spy = spyOn(console, 'error');
      try {
        await postLocal('/api/share/enabled', { workspaceId: other, enabled: false, reason: 'x' });
        await postOwner('/api/share/enabled', { workspaceId: other, enabled: true });
        const lines = flipLines(spy);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain(`board "${other}" closed to outside visitors`);
        expect(lines[1]).toContain(`board "${other}" opened to outside visitors`);
      } finally {
        spy.mockRestore();
      }
    });

    it('is not written for a refused call', async () => {
      const spy = spyOn(console, 'error');
      try {
        await postLocal('/api/share/enabled', { enabled: 'no' });
        await postLocal('/api/share/enabled', { workspaceId: 'w-nope', enabled: false });
        expect(flipLines(spy)).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
