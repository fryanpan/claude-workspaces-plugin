/**
 * Owner, edit, comment and view over the real server (D1 step 8).
 *
 * A share-link member's role reaches their socket at connect, a comment or
 * view socket's doc edit and any socket's write to `threads` are dropped
 * when the board enforces roles and applied-but-logged when it reports
 * only, and changing a role or revoking a token hangs up what was open.
 *
 * The harness is `share-link-flow.test.ts`'s: an Access-fronted share
 * hostname and a board shared by a link. Every name here is invented.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'board-access-roles-kid';
const SHARE_AUD = 'aud-for-the-share-app';
const OWNER_AUD = 'aud-for-the-owner-app';
const SHARE_HOST = 'share.example.test';
const OWNER_HOST = 'workspaces.example.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const OWNER_EMAIL = 'owner@example.test';

const MSG_SYNC = 0;
const MSG_PROBE = 3;
const MSG_ACCESS = 4;

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
      .setSubject('cf-access-board-access-roles')
      .sign(privateKey);
});

/** An open socket, every frame it has received, and the probe round trip. */
interface Conn {
  ws: WebSocket;
  frames: Uint8Array[];
  closed: Promise<number>;
}

const kindOf = (frame: Uint8Array): number => decoding.readVarUint(decoding.createDecoder(frame));

/** A sync update frame writing whatever `mutate` does to a fresh doc. */
function updateFrame(mutate: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  mutate(doc);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(enc);
}

describe('board roles over the real server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let board: string;
  let docId: string;

  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });
  const local = (path: string, init: RequestInit = {}) =>
    req(path, `localhost:${handle.port}`, init);
  const postLocal = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Sign `email` in through a fresh link, so they are a member. */
  const join_ = async (email: string) => {
    const r = await postLocal('/api/share/workspace', { workspaceId: board });
    expect(r.status, await r.clone().text()).toBe(200);
    const { link } = (await r.json()) as { link: { linkId: string } };
    const redeemed = await req(`/s/${link.linkId}`, SHARE_HOST, {
      headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, email) },
    });
    expect(redeemed.status).toBe(302);
  };

  const setRole = (email: string, role: string) =>
    postLocal(`/workspaces/${board}/members/${encodeURIComponent(email)}/role`, { role });
  const setMode = (mode: string) => postLocal(`/workspaces/${board}/roles-mode`, { mode });

  const open = async (headers: Record<string, string>, path = `docs/${docId}/y`) => {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/workspaces/${board}/${path}`, {
      headers,
    } as unknown as string[]);
    ws.binaryType = 'arraybuffer';
    const frames: Uint8Array[] = [];
    ws.addEventListener('message', (e) => frames.push(new Uint8Array(e.data as ArrayBuffer)));
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (e) => resolve((e as CloseEvent).code));
    });
    const opened = await new Promise<boolean>((resolve) => {
      ws.addEventListener('open', () => resolve(true));
      ws.addEventListener('error', () => resolve(false));
    });
    expect(opened).toBe(true);
    return { ws, frames, closed } satisfies Conn;
  };
  const asMember = async (email: string): Promise<Conn> =>
    open({
      host: SHARE_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': await signJwt(SHARE_AUD, email),
    });
  const asOwner = async (): Promise<Conn> =>
    open({
      host: OWNER_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL),
    });

  /** The `{ role, mode }` frame the server sends at connect. */
  const accessFrame = async (c: Conn): Promise<{ role: string; mode: string }> => {
    await waitFor(() => c.frames.some((f) => kindOf(f) === MSG_ACCESS), {
      describe: 'the access frame',
    });
    const frame = c.frames.find((f) => kindOf(f) === MSG_ACCESS) as Uint8Array;
    const dec = decoding.createDecoder(frame);
    decoding.readVarUint(dec);
    return JSON.parse(decoding.readVarString(dec)) as { role: string; mode: string };
  };

  /** Send a frame, then a probe; the probe's echo means the frame was handled. */
  const sendAndSettle = async (c: Conn, frame: Uint8Array) => {
    const before = c.frames.filter((f) => kindOf(f) === MSG_PROBE).length;
    c.ws.send(frame);
    const probe = encoding.createEncoder();
    encoding.writeVarUint(probe, MSG_PROBE);
    c.ws.send(encoding.toUint8Array(probe));
    await waitFor(() => c.frames.filter((f) => kindOf(f) === MSG_PROBE).length > before, {
      describe: 'the probe echo',
    });
  };

  const live = () => {
    const doc = handle.docStore.get(docId);
    if (!doc) throw new Error('doc not live');
    return doc.ydoc;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'board-access-roles-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      proxiedTrustedHosts: [OWNER_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const created = await postLocal('/workspaces', { name: 'Harborlight' });
    board = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const path = join(dataDir, 'riverbend-notes.md');
    writeFileSync(path, '# Riverbend notes\n\nBody.\n');
    const doc = await postLocal(`/workspaces/${board}/docs`, {
      docId: 'riverbend-notes',
      type: 'markdown',
      sourceUrl: path,
    });
    expect(doc.status).toBe(200);
    docId = ((await doc.json()) as { docId: string }).docId;
    const filed = await postLocal(`/workspaces/${board}/docs:attach`, { docId });
    expect(filed.status).toBe(200);
    handle.shareLinks.addToAudience(board, ['@harborlight.example'], 'Saltmarsh');
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('tells each socket its role at connect, and the API sets all four', async () => {
    const alice = 'alice@harborlight.example';
    await join_(alice);
    const owner = await asOwner();
    expect(await accessFrame(owner)).toMatchObject({ role: 'owner', mode: 'report-only' });
    owner.ws.close();
    for (const role of ['comment', 'view', 'edit']) {
      const set = await setRole(alice, role);
      expect(set.status, await set.clone().text()).toBe(200);
      const c = await asMember(alice);
      expect(await accessFrame(c)).toMatchObject({ role, mode: 'report-only' });
      c.ws.close();
    }
    // The old payload still works, as edit.
    expect(await (await setRole(alice, 'member')).json()).toMatchObject({ accessRole: 'edit' });
    expect((await setRole(alice, 'Owner')).status).toBe(400);
    const listed = (await (await local(`/workspaces/${board}/members`)).json()) as {
      rolesMode: string;
      members: Array<{ email: string; accessRole: string }>;
    };
    expect(listed.rolesMode).toBe('report-only');
    expect(listed.members.find((m) => m.email === alice)?.accessRole).toBe('edit');
  });

  it('report-only: a comment socket’s edit goes through, and the refusal is logged', async () => {
    const bob = 'bob@harborlight.example';
    await join_(bob);
    expect((await setRole(bob, 'comment')).status).toBe(200);
    const warn = spyOn(console, 'warn');
    try {
      const c = await asMember(bob);
      await accessFrame(c);
      await sendAndSettle(
        c,
        updateFrame((d) => d.getText('report-only-probe').insert(0, 'from a commenter')),
      );
      expect(live().getText('report-only-probe').toString()).toBe('from a commenter');
      const lines = warn.mock.calls.map((args) => String(args[0]));
      expect(lines.some((l) => /report-only, would refuse a role write/.test(l))).toBe(true);
      c.ws.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('enforce: a view or comment socket’s edit is dropped and an edit socket’s lands', async () => {
    const viewer = 'viewer@harborlight.example';
    const editor = 'editor@harborlight.example';
    await join_(viewer);
    await join_(editor);
    expect((await setRole(viewer, 'view')).status).toBe(200);
    expect((await setRole(editor, 'edit')).status).toBe(200);
    expect(await (await setMode('enforce')).json()).toMatchObject({ rolesMode: 'enforce' });
    try {
      const v = await asMember(viewer);
      expect(await accessFrame(v)).toMatchObject({ role: 'view', mode: 'enforce' });
      await sendAndSettle(
        v,
        updateFrame((d) => d.getText('enforce-probe').insert(0, 'viewer')),
      );
      expect(live().getText('enforce-probe').toString()).toBe('');
      // The positive control: the same frame from an edit socket lands.
      const e = await asMember(editor);
      await sendAndSettle(
        e,
        updateFrame((d) => d.getText('enforce-probe').insert(0, 'editor')),
      );
      expect(live().getText('enforce-probe').toString()).toBe('editor');
      v.ws.close();
      e.ws.close();
    } finally {
      await setMode('report-only');
    }
  });

  it('comments are written only by the server: a socket write to threads is dropped', async () => {
    const forged = (id: string) =>
      updateFrame((d) => {
        const t = new Y.Map<unknown>();
        t.set('author', 'Someone Else');
        d.getMap('threads').set(id, t);
      });
    // Report-only: applied, and logged.
    const owner = await asOwner();
    await accessFrame(owner);
    await sendAndSettle(owner, forged('t-reported'));
    expect(live().getMap('threads').has('t-reported')).toBe(true);
    expect(await (await setMode('enforce')).json()).toMatchObject({ rolesMode: 'enforce' });
    try {
      // The mode is read per frame, so the socket already open follows it.
      await sendAndSettle(owner, forged('t-enforced'));
      expect(live().getMap('threads').has('t-enforced')).toBe(false);
      // The server's own route still writes a comment.
      const before = live().getMap('threads').size;
      const posted = await postLocal(`/workspaces/${board}/docs/${docId}/threads`, {
        anchor: { kind: 'orphan' },
        text: 'A comment the server stamps.',
        author: { id: 'agent:harborlight', name: 'Harborlight', kind: 'agent' },
      });
      expect(posted.status, await posted.clone().text()).toBeLessThan(300);
      expect(live().getMap('threads').size).toBe(before + 1);
      owner.ws.close();
    } finally {
      await setMode('report-only');
    }
  });

  it('changing a member’s role hangs up their socket, and not the owner’s', async () => {
    const who = 'riverbend@harborlight.example';
    await join_(who);
    const member = await asMember(who);
    const owner = await asOwner();
    const r = await setRole(who, 'view');
    expect(await r.json()).toMatchObject({ ok: true, accessRole: 'view', closedSockets: 1 });
    expect(await member.closed).toBe(1008);
    expect(owner.ws.readyState).toBe(WebSocket.OPEN);
    owner.ws.close();
  });

  it('revoking a board token hangs up the socket it opened', async () => {
    const minted = await postLocal('/api/board-tokens', {
      boardId: board,
      agentId: 'agent-harborlight',
      label: 'Harborlight relay',
    });
    expect(minted.status, await minted.clone().text()).toBe(201);
    const { id, token } = (await minted.json()) as { id: string; token: string };
    const c = await open({ host: `localhost:${handle.port}`, authorization: `Bearer ${token}` });
    expect(await accessFrame(c)).toMatchObject({ role: 'edit' });
    const revoked = await local(`/api/board-tokens/${id}/revoke`, { method: 'POST' });
    expect(revoked.status).toBe(200);
    expect(await c.closed).toBe(1008);
  });
});
