/**
 * Owner, edit, comment and view over the real server (D1 step 8).
 *
 * A member's role reaches their socket at connect; a comment or view
 * socket's edit and any socket's `threads` write are dropped under enforce
 * (every board's default) and applied-but-logged under report-only; a role
 * change or a revoked token hangs up what was open.
 *
 * The harness is `share-link-flow.test.ts`'s: an Access-fronted share
 * hostname and a board shared by a link. Every name here is invented.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCollabStorage, createRoomHost } from '@claude-workspaces/core/collab';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
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
const MSG_RESET = 2;
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

  /** The owner's own browser: Access proves the owner, the page says
   *  same-origin. A widening from loopback alone is refused
   *  (`owner-proof-widenings.test.ts`). */
  const postOwner = async (path: string, body: unknown) =>
    req(path, OWNER_HOST, {
      method: 'POST',
      headers: {
        ...CF_RAY,
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
        'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL),
        origin: `https://${OWNER_HOST}`,
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify(body),
    });
  const setRole = (email: string, role: string) =>
    postOwner(`/workspaces/${board}/members/${encodeURIComponent(email)}/role`, { role });
  const setMode = (mode: string) => postOwner(`/workspaces/${board}/roles-mode`, { mode });

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

  /** A doc edit from `c`: `text` typed at the start of the root `key`. */
  const typeInto = (c: Conn, key: string, text: string) =>
    sendAndSettle(
      c,
      updateFrame((d) => d.getText(key).insert(0, text)),
    );

  /**
   * Sync `page` the way `core/ws-client.ts` does: send our step 1, answer
   * every sync frame with `readSyncMessage` in arrival order, and send back
   * whatever it writes — the step 2 answering the server's step 1 included.
   */
  const runSyncAsPage = async (c: Conn, page: Y.Doc) => {
    const ask = encoding.createEncoder();
    encoding.writeVarUint(ask, MSG_SYNC);
    syncProtocol.writeSyncStep1(ask, page);
    c.ws.send(encoding.toUint8Array(ask));
    let read = 0;
    let answered = false;
    let synced = false;
    await waitFor(
      () => {
        for (; read < c.frames.length; read++) {
          const dec = decoding.createDecoder(c.frames[read] as Uint8Array);
          if (decoding.readVarUint(dec) !== MSG_SYNC) continue;
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_SYNC);
          const type = syncProtocol.readSyncMessage(dec, enc, page, 'server');
          if (encoding.length(enc) > 1) c.ws.send(encoding.toUint8Array(enc));
          if (type === syncProtocol.messageYjsSyncStep1) answered = true;
          if (type === syncProtocol.messageYjsSyncStep2) synced = true;
        }
        return answered && synced;
      },
      { describe: 'the page’s sync handshake' },
    );
    const probes = c.frames.filter((f) => kindOf(f) === MSG_PROBE).length;
    const probe = encoding.createEncoder();
    encoding.writeVarUint(probe, MSG_PROBE);
    c.ws.send(encoding.toUint8Array(probe));
    await waitFor(() => c.frames.filter((f) => kindOf(f) === MSG_PROBE).length > probes, {
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
      ownerEmail: OWNER_EMAIL,
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
    resetOwnerIdentities();
  });

  it('tells each socket its role at connect, and the API sets all four', async () => {
    const alice = 'alice@harborlight.example';
    await join_(alice);
    const owner = await asOwner();
    expect(await accessFrame(owner)).toMatchObject({ role: 'owner', mode: 'enforce' });
    owner.ws.close();
    for (const role of ['comment', 'view', 'edit']) {
      const set = await setRole(alice, role);
      expect(set.status, await set.clone().text()).toBe(200);
      const c = await asMember(alice);
      expect(await accessFrame(c)).toMatchObject({ role, mode: 'enforce' });
      c.ws.close();
    }
    // The old payload still works, as edit.
    expect(await (await setRole(alice, 'member')).json()).toMatchObject({ accessRole: 'edit' });
    expect((await setRole(alice, 'Owner')).status).toBe(400);
    const listed = (await (await local(`/workspaces/${board}/members`)).json()) as {
      rolesMode: string;
      members: Array<{ email: string; accessRole: string }>;
    };
    expect(listed.rolesMode).toBe('enforce');
    expect(listed.members.find((m) => m.email === alice)?.accessRole).toBe('edit');
  });

  it('a board whose mode was never set enforces: a view or comment socket’s edit is dropped, and the owner’s and an editor’s land', async () => {
    const viewer = 'viewer@harborlight.example';
    const editor = 'editor@harborlight.example';
    await join_(viewer);
    await join_(editor);
    expect((await setRole(viewer, 'view')).status).toBe(200);
    expect((await setRole(editor, 'edit')).status).toBe(200);
    // No roles-mode call has been made on this board.
    expect(handle.shareLinks.rolesModeOf(board)).toBe('enforce');
    const warn = spyOn(console, 'warn');
    try {
      const v = await asMember(viewer);
      expect(await accessFrame(v)).toMatchObject({ role: 'view', mode: 'enforce' });
      await typeInto(v, 'enforce-probe', 'viewer');
      expect(live().getText('enforce-probe').toString()).toBe('');
      // Told to drop the state it now holds, so it does not diverge silently.
      expect(v.frames.some((f) => kindOf(f) === MSG_RESET)).toBe(true);
      const lines = warn.mock.calls.map((args) => String(args[0]));
      expect(lines.some((l) => /\[roles\] refused a role write/.test(l))).toBe(true);
      // The positive controls: the same frame from an edit socket, and from
      // the owner's, lands.
      const e = await asMember(editor);
      await typeInto(e, 'enforce-probe', 'editor');
      expect(live().getText('enforce-probe').toString()).toBe('editor');
      expect(e.frames.some((f) => kindOf(f) === MSG_RESET)).toBe(false);
      const o = await asOwner();
      await accessFrame(o);
      await typeInto(o, 'enforce-owner-probe', 'owner');
      expect(live().getText('enforce-owner-probe').toString()).toBe('owner');
      expect(o.frames.some((f) => kindOf(f) === MSG_RESET)).toBe(false);
      v.ws.close();
      e.ws.close();
      o.ws.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('report-only, once the owner sets it: a comment socket’s edit goes through, and the refusal is logged', async () => {
    const bob = 'bob@harborlight.example';
    await join_(bob);
    expect((await setRole(bob, 'comment')).status).toBe(200);
    expect(await (await setMode('report-only')).json()).toMatchObject({
      rolesMode: 'report-only',
    });
    const warn = spyOn(console, 'warn');
    try {
      const c = await asMember(bob);
      expect(await accessFrame(c)).toMatchObject({ role: 'comment', mode: 'report-only' });
      await typeInto(c, 'report-only-probe', 'from a commenter');
      expect(live().getText('report-only-probe').toString()).toBe('from a commenter');
      const lines = warn.mock.calls.map((args) => String(args[0]));
      expect(lines.some((l) => /report-only, would refuse a role write/.test(l))).toBe(true);
      expect(c.frames.some((f) => kindOf(f) === MSG_RESET)).toBe(false);
      c.ws.close();
    } finally {
      warn.mockRestore();
      await setMode('enforce');
    }
  });

  it('enforce drops only what the role does not allow: owner, editor and commenter thread writes land', async () => {
    const forged = (id: string) =>
      updateFrame((d) => {
        const t = new Y.Map<unknown>();
        t.set('author', 'Someone Else');
        d.getMap('threads').set(id, t);
      });
    const threads = () => live().getMap('threads');
    const viewer = await asMember('viewer@harborlight.example');
    await accessFrame(viewer);
    // Report-only applies it; enforce, read per frame, drops the next one.
    await setMode('report-only');
    await sendAndSettle(viewer, forged('t-seen'));
    expect(threads().has('t-seen')).toBe(true);
    expect(await (await setMode('enforce')).json()).toMatchObject({ rolesMode: 'enforce' });
    await sendAndSettle(viewer, forged('t-dropped'));
    expect(threads().has('t-dropped')).toBe(false);
    expect(viewer.frames.some((f) => kindOf(f) === MSG_RESET)).toBe(true);
    const [owner, editor] = await Promise.all([asOwner(), asMember('editor@harborlight.example')]);
    const member = handle.shareLinks.membersOf(board).find((m) => m.access === 'comment');
    const commenter = await asMember(member?.email ?? '');
    expect(await accessFrame(commenter)).toMatchObject({ role: 'comment', mode: 'enforce' });
    await Promise.all([accessFrame(owner), accessFrame(editor)]);
    await sendAndSettle(owner, forged('t-owner'));
    await sendAndSettle(editor, forged('t-editor'));
    await sendAndSettle(commenter, forged('t-commenter'));
    for (const id of ['t-owner', 't-editor', 't-commenter']) expect(threads().has(id)).toBe(true);
    await typeInto(commenter, 'commenter-probe', 'from a commenter');
    expect(live().getText('commenter-probe').toString()).toBe('');
    expect(commenter.frames.some((f) => kindOf(f) === MSG_RESET)).toBe(true);
    for (const c of [viewer, owner, editor, commenter]) c.ws.close();
  });

  it('enforce: a page reconnecting to a doc with a resolved comment is not refused', async () => {
    // Every would-refuse event prod logged before this fix. Resolving a
    // comment overwrites its status, a delete under `threads`; Yjs re-sends
    // the doc's whole delete set in the step 2 a page answers the server's
    // step 1 with, so each reconnect read as a threads write.
    const posted = await postLocal(`/workspaces/${board}/docs/${docId}/threads`, {
      anchor: { kind: 'orphan' },
      text: 'Riverbend wants this checked.',
      author: { id: 'agent:harborlight', name: 'Harborlight', kind: 'agent' },
    });
    expect(posted.status, await posted.clone().text()).toBeLessThan(300);
    const { thread } = (await posted.json()) as { thread: { id: string } };
    const resolved = await postLocal(
      `/workspaces/${board}/docs/${docId}/threads/${thread.id}/resolve`,
      { author: { id: 'agent:harborlight', name: 'Harborlight', kind: 'agent' } },
    );
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    const viewer = 'saltmarsh-viewer@harborlight.example';
    await join_(viewer);
    expect((await setRole(viewer, 'view')).status).toBe(200);
    expect(handle.shareLinks.rolesModeOf(board)).toBe('enforce');
    const warn = spyOn(console, 'warn');
    try {
      for (const connect of [asOwner, () => asMember(viewer)]) {
        // The page's doc, carried across the reconnect as a tab keeps it.
        const page = new Y.Doc();
        for (let attempt = 0; attempt < 2; attempt++) {
          const c = await connect();
          await accessFrame(c);
          await runSyncAsPage(c, page);
          expect(c.frames.some((f) => kindOf(f) === MSG_RESET)).toBe(false);
          c.ws.close();
          await c.closed;
        }
        const t = (page.getMap('threads').get(thread.id) as Y.Map<unknown>).get('status');
        expect(t).toBe('resolved');
      }
      const lines = warn.mock.calls.map((args) => String(args[0]));
      expect(lines.filter((l) => l.includes('[roles]'))).toEqual([]);
    } finally {
      warn.mockRestore();
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

  it('a role change or a removal reaches a core room host too', async () => {
    // Step 3's room host keys nothing on the socket; it asks its role
    // function again when the server calls `recheckRoles` on a revoke.
    const who = 'saltmarsh@harborlight.example';
    await join_(who);
    const host = createRoomHost({
      storage: new MemoryCollabStorage(),
      role: (p) => handle.shareLinks.accessRoleOf(board, p.id),
    });
    const unregister = handle.collabRooms.register(host);
    try {
      let revoked = 0;
      const opened = host.connect({
        roomId: 'harborlight-room',
        principal: { id: who },
        send: () => {},
        onRevoked: () => {
          revoked++;
        },
      });
      if (!opened.ok) throw new Error(opened.error);
      expect(opened.connection.role).toBe('edit');
      expect((await setRole(who, 'view')).status).toBe(200);
      expect(opened.connection.role).toBe('view');
      expect(revoked).toBe(0);
      const removed = await local(`/workspaces/${board}/members/${encodeURIComponent(who)}`, {
        method: 'DELETE',
      });
      expect(removed.status).toBe(200);
      expect(revoked).toBe(1);
    } finally {
      unregister();
    }
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
    expect(await accessFrame(c)).toMatchObject({ role: 'edit', mode: 'enforce' });
    // An edit-capped agent's write lands on an enforcing board.
    await typeInto(c, 'token-probe', 'agent');
    expect(live().getText('token-probe').toString()).toBe('agent');
    const revoked = await local(`/api/board-tokens/${id}/revoke`, { method: 'POST' });
    expect(revoked.status).toBe(200);
    expect(await c.closed).toBe(1008);
  });
});
