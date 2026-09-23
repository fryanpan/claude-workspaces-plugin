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
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { STAMP_PATTERN } from '../src/log-stamp.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'sharing-switch-kid';
const SHARE_AUD = 'aud-share-app';
const OWNER_AUD = 'aud-owner-app';
const SHARE_HOST = 'share.harborlight.test';
const OWNER_HOST = 'workspaces.harborlight.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const MEMBER = 'bob@riverbend.example';
const LATE_MEMBER = 'alice@saltmarsh.example';
const OWNER_EMAIL = 'owner@harborlight.test';

let jwks: JSONWebKeySet;
let signJwt: (aud: string, email: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  signJwt = (aud, email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-visitor')
      .sign(privateKey);
});

describe('the sharing switch, for one board and for all of them', () => {
  const judged: string[] = [];
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let closing: string;
  let other: string;
  let closingLink: string;

  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });
  const postLocal = (path: string, body: unknown) =>
    req(path, `localhost:${handle.port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const onShareHost = async (path: string, email: string) =>
    req(path, SHARE_HOST, {
      headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, email) },
    });
  const onOwnerHost = async (path: string) =>
    req(path, OWNER_HOST, {
      headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL) },
    });
  const boardPath = (id: string) => `/workspaces/${encodeURIComponent(id)}?format=json`;
  const status = async () =>
    (
      (await (await req('/api/share', `localhost:${handle.port}`)).json()) as {
        sharing: { enabled: boolean; locked: boolean; closedBoards?: string[] };
      }
    ).sharing;

  const boardWithLink = async (name: string): Promise<{ id: string; linkId: string }> => {
    const created = await postLocal('/workspaces', { name });
    expect(created.status).toBe(200);
    const id = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const minted = await postLocal('/api/share/workspace', { workspaceId: id });
    expect(minted.status, await minted.clone().text()).toBe(200);
    const linkId = ((await minted.json()) as { link: { linkId: string } }).link.linkId;
    return { id, linkId };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'sharing-switch-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      proxiedTrustedHosts: [OWNER_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
      // The quality gate, stubbed to pass and to record what it was shown, so
      // the notice block can see the server's own item went through it.
      reviewJudge: async (input) => {
        judged.push(input.item.headline ?? '');
        return { ok: true, reason: 'fine' };
      },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const a = await boardWithLink('Harborlight board');
    const b = await boardWithLink('Riverbend board');
    closing = a.id;
    closingLink = a.linkId;
    other = b.id;
    // The member joins both boards through their links.
    expect((await onShareHost(`/s/${a.linkId}`, MEMBER)).status).toBe(302);
    expect((await onShareHost(`/s/${b.linkId}`, MEMBER)).status).toBe(302);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
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

    it('reopens that board', async () => {
      const r = await postLocal('/api/share/enabled', { workspaceId: closing, enabled: true });
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
        const on = await postLocal('/api/share/enabled', { enabled: true });
        expect(on.status).toBe(200);
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
        expect(onLine).toContain('"unattributed"');
        expect(onLine).toMatch(/ from (::ffff:)?127\.0\.0\.1 /);
        expect(onLine).toContain('reason=none given');
      } finally {
        spy.mockRestore();
      }
    });

    it('is written for a board flip too, naming the board', async () => {
      const spy = spyOn(console, 'error');
      try {
        await postLocal('/api/share/enabled', { workspaceId: other, enabled: false, reason: 'x' });
        await postLocal('/api/share/enabled', { workspaceId: other, enabled: true });
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

  describe("the owner's notice", () => {
    type Row = {
      reviewItemId: string;
      taskId: string;
      askedBy: string;
      review: { headline: string; detail: string; options?: Array<{ id: string; label: string }> };
    };
    const HEADLINE = 'External sharing was turned off';
    const unfiledBoard = async (): Promise<string | undefined> => {
      const r = await req('/workspaces?format=json', `localhost:${handle.port}`);
      const body = (await r.json()) as { boardWorkspaces: Array<{ id: string; name: string }> };
      return body.boardWorkspaces.find((w) => w.name === 'Unfiled')?.id;
    };
    /** Open items on the owner's catch-all board that the switch filed. */
    const notices = async (): Promise<Row[]> => {
      const ws = await unfiledBoard();
      if (!ws) return [];
      const r = await req(`/workspaces/${ws}/review-items`, `localhost:${handle.port}`);
      const rows = ((await r.json()) as { items: Row[] }).items;
      return rows.filter((row) => row.askedBy === 'Sharing switch');
    };
    const masterEnabled = async (): Promise<boolean> => {
      const r = await req('/api/share', `localhost:${handle.port}`);
      return ((await r.json()) as { sharing: { enabled: boolean } }).sharing.enabled;
    };

    it('files nothing when one board is closed', async () => {
      expect(await notices()).toHaveLength(0);
      await postLocal('/api/share/enabled', { workspaceId: other, enabled: false });
      await postLocal('/api/share/enabled', { workspaceId: other, enabled: true });
      expect(await notices()).toHaveLength(0);
    });

    it("puts the master switch going off on the owner's queue as a decision, through the quality gate", async () => {
      const off = await postLocal('/api/share/enabled', {
        enabled: false,
        reason: 'a precaution',
        actor: { id: 'agent-riverbend', name: 'Riverbend Agent' },
      });
      expect(off.status).toBe(200);
      // Read straight after the 200: the item is on the queue before the
      // route answers, so the owner's open board has it on its next event.
      const rows = await notices();
      expect(rows).toHaveLength(1);
      const [row] = rows as [Row];
      expect(row.review.headline).toBe(HEADLINE);
      expect(row.review.options?.map((o) => o.label)).toEqual(['Turn back on', 'Leave off']);
      expect(row.review.detail).toContain('The agent Riverbend Agent turned off');
      expect(row.review.detail).not.toContain('agent-riverbend');
      expect(row.review.detail).toContain('a precaution');
      expect(row.review.detail).toMatch(/(::ffff:)?127\.0\.0\.1/);
      // The gate was asked about it and passed it; it is not held.
      await waitFor(() => judged.includes(HEADLINE));
    });

    it('revises the one item when it goes off again, naming the latest flip', async () => {
      const before = (await notices())[0]?.reviewItemId;
      expect(before).toBeString();
      await postLocal('/api/share/enabled', { enabled: false, reason: 'second look' });
      const rows = await notices();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reviewItemId).toBe(before as string);
      expect(rows[0]?.review.detail).toContain('second look');
    });

    it('withdraws the item when the switch is turned back on', async () => {
      await postLocal('/api/share/enabled', { enabled: true });
      expect(await notices()).toHaveLength(0);
    });

    it('turns the switch back on when the owner answers Turn back on, and logs the owner as the actor', async () => {
      await postLocal('/api/share/enabled', { enabled: false, reason: 'third time' });
      const [row] = (await notices()) as [Row];
      const ws = await unfiledBoard();
      const lines: string[] = [];
      const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
      try {
        const answered = await postLocal(
          `/workspaces/${ws}/tasks/${row.taskId}/review-items/${row.reviewItemId}/answer`,
          {
            text: 'Turn back on',
            answeredWith: 'turn-back-on',
            author: { id: 'known-bryan', name: 'Bryan', kind: 'person' },
          },
        );
        expect(answered.status).toBe(200);
      } finally {
        spy.mockRestore();
      }
      expect(await masterEnabled()).toBe(true);
      const line = lines.find((l) => l.includes('[sharing] master switch ON'));
      expect(line).toContain('by "owner Bryan (known-bryan)"');
      expect(await notices()).toHaveLength(0);
    });

    it('leaves the switch off when an agent answers Turn back on', async () => {
      await postLocal('/api/share/enabled', { enabled: false, reason: 'fourth time' });
      const [row] = (await notices()) as [Row];
      const ws = await unfiledBoard();
      const answered = await postLocal(
        `/workspaces/${ws}/tasks/${row.taskId}/review-items/${row.reviewItemId}/answer`,
        {
          text: 'Turn back on',
          answeredWith: 'turn-back-on',
          author: { id: 'agent-riverbend', name: 'Riverbend Agent', kind: 'agent' },
        },
      );
      expect(answered.status).toBe(200);
      expect(await masterEnabled()).toBe(false);
      await postLocal('/api/share/enabled', { enabled: true });
    });

    it('files on a live board nobody outside can reach when the catch-all board is retired', async () => {
      const unfiled = await unfiledBoard();
      expect(unfiled).toBeString();
      const retired = await req(`/workspaces/${unfiled}/retired`, `localhost:${handle.port}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retired: true, author: { id: 'known-bryan', name: 'Bryan' } }),
      });
      expect(retired.status).toBe(200);
      const created = await postLocal('/workspaces', { name: 'Saltmarsh board' });
      const live = ((await created.json()) as { workspace: { id: string } }).workspace.id;

      await postLocal('/api/share/enabled', { enabled: false, reason: 'catch-all retired' });

      const r = await req(`/workspaces/${live}/review-items`, `localhost:${handle.port}`);
      const rows = ((await r.json()) as { items: Row[] }).items.filter(
        (row) => row.askedBy === 'Sharing switch',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.review.headline).toBe(HEADLINE);
      expect(rows[0]?.review.detail).toContain('catch-all retired');
      // The shared boards got nothing: the item names an address on this machine.
      for (const board of [closing, other]) {
        const shared = await req(`/workspaces/${board}/review-items`, `localhost:${handle.port}`);
        const items = ((await shared.json()) as { items: Row[] }).items;
        expect(items.filter((row) => row.askedBy === 'Sharing switch')).toHaveLength(0);
      }
      await postLocal('/api/share/enabled', { enabled: true });
    });
  });
});
