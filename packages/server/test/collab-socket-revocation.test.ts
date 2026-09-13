/**
 * A collaborator on the COLLABORATION hostname loses their open doc socket
 * when the share that admitted them ends — revoked, expired, or every share at
 * once by the external-access switch.
 *
 * A websocket is authorized once, at its upgrade, and never re-checked. The
 * sweeps that hang one up find it by the stamp it carries: `shareId` for a
 * share-hostname visitor, the membership key for a share-link member. A
 * collaboration-hostname visitor used to carry neither, so revoking the share
 * that admitted them closed the door to their next HTTP request while their
 * `/y/<doc>` kept reading AND writing until they disconnected.
 *
 * The fixture is prod-shaped, which takes two boots of one data directory:
 * the shares that admit collaborators are records minted by the retired
 * per-share route, and a server with a share hostname configured refuses to
 * mint them. So the first boot mints them and the second — share hostname,
 * collaboration hostname and the old registry all live — is the one under
 * test, exactly as prod runs while those records drain.
 *
 * Every test attempts to hang up two things at once: the collaborator, and a
 * visitor the same verb ALREADY hung up before this fix. That second one is
 * the positive control. Without it a socket that stayed open could mean the
 * verb ran and missed, or that the verb never ran at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, type ServerOptions, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'collab-revoke-kid';
/** The owner's Access application, which also fronts the collaboration host. */
const OWNER_AUD = 'aud-for-the-owner-app';
/** The share hostname's own application. */
const SHARE_AUD = 'aud-for-the-share-app';
const COLLAB_HOST = 'collab.example.test';
const SHARE_HOST = 'share.example.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const MSG_SYNC = 0;

/** Admitted to a board by a DOMAIN entry on its share. */
const REVIEWER = 'reviewer@harborlight.example';
/** Admitted by a domain entry AND, on one board, by a second share naming them. */
const NAMED = 'named@harborlight.example';
/** Admitted to a different board, by a different share. */
const GUEST = 'guest@saltmarsh.example';

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
      .setSubject('cf-access-collab-visitor')
      .sign(privateKey);
});

interface MintedShare {
  shareId: string;
  hostname: string;
  audience: string;
}

interface Board {
  boardId: string;
  docId: string;
}

/** A connected Yjs client: its close, and a way to try writing through it. */
interface Conn {
  ws: WebSocket;
  opened: boolean;
  closed: Promise<number>;
  /** Set a value in the probe map; the update goes out over this socket if
   *  it is still open. */
  write: (value: string) => void;
}

const PROBE = 'collab-revoke-probe';

describe('revoking access hangs up a collaboration-hostname socket', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  /** Boards, each with the shares minted for it in the first boot. */
  let revoked: Board & { share: MintedShare };
  let overlapped: Board & { domainShare: MintedShare; namedShare: MintedShare };
  let untouched: Board & { share: MintedShare };
  let switchedOff: Board & { share: MintedShare };
  let expiring: Board & { share: MintedShare };
  let alsoLinked: Board & { share: MintedShare };

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

  /** Open `/y/<doc>` on a board with the given headers. */
  const connect = (board: Board, headers: Record<string, string>): Promise<Conn> => {
    const ydoc = new Y.Doc();
    const ws = new WebSocket(
      `ws://127.0.0.1:${handle.port}/workspaces/${board.boardId}/docs/${board.docId}/y`,
      { headers } as unknown as string[],
    );
    ws.binaryType = 'arraybuffer';
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (e) => resolve((e as CloseEvent).code));
    });
    ydoc.on('update', (update: Uint8Array) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      ws.send(encoding.toUint8Array(enc));
    });
    return new Promise<Conn>((resolve) => {
      const done = (opened: boolean) =>
        resolve({
          ws,
          opened,
          closed,
          write: (value) => ydoc.getMap(PROBE).set('value', value),
        });
      ws.addEventListener('open', () => done(true));
      ws.addEventListener('error', () => done(false));
    });
  };

  /** Through the edge, on `host`, holding a token for `aud`. */
  const viaEdge = async (board: Board, host: string, aud: string, email: string) =>
    connect(board, { host, ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(aud, email) });
  const asCollaborator = (board: Board, email: string) =>
    viaEdge(board, COLLAB_HOST, OWNER_AUD, email);
  /** The machine's owner, over loopback — no sweep may ever reach this one. */
  const asOwner = (board: Board) => connect(board, { host: `localhost:${handle.port}` });
  /** The retired per-share hostname: stamped with `shareId`, swept before this fix. */
  const asShareHostVisitor = (board: Board, share: MintedShare) =>
    viaEdge(board, share.hostname, share.audience, REVIEWER);
  /** A share-link member: stamped with a membership key, swept before this fix. */
  const asLinkMember = (board: Board, email: string) =>
    viaEdge(board, SHARE_HOST, SHARE_AUD, email);

  /** Mint a share link on this boot and redeem it, making `email` a member. */
  const redeemLinkFor = async (boardId: string, email: string) => {
    const minted = await postLocal('/api/share/workspace', { workspaceId: boardId });
    expect(minted.status, await minted.clone().text()).toBe(200);
    const { link } = (await minted.json()) as { link: { linkId: string } };
    const redeemed = await req(`/s/${link.linkId}`, SHARE_HOST, {
      headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, email) },
    });
    expect(redeemed.status).toBe(302);
  };

  /** What the SERVER's copy of the doc holds under the probe key. */
  const serverValue = (board: Board): unknown =>
    handle.docStore.get(board.docId)?.ydoc.getMap(PROBE).get('value');

  /** A code if the socket closed within the window, else 'still-open'. */
  const closeCodeWithin = (conn: Conn, ms = 2000): Promise<number | 'still-open'> =>
    Promise.race([
      conn.closed,
      new Promise<'still-open'>((r) => setTimeout(() => r('still-open'), ms)),
    ]);

  /**
   * Try to write through a socket whose access just ended, and report
   * whether the write reached the server.
   *
   * If the socket is still open, wait for the write to land — which it does,
   * and that is the defect. If it is closed there is nothing to wait for:
   * the client cannot send, and the server has dropped the connection.
   */
  const writeAfterRevocation = async (conn: Conn, board: Board, value: string) => {
    conn.write(value);
    await waitFor(() => serverValue(board) === value || conn.ws.readyState !== WebSocket.OPEN, {
      describe: 'the write to land, or the socket to be closed',
    });
    return serverValue(board) === value ? 'landed' : 'refused';
  };

  /** The positive control for the write path itself: it lands while access holds. */
  const writeLands = async (conn: Conn, board: Board, value: string) => {
    conn.write(value);
    await waitFor(() => serverValue(board) === value, { describe: `${value} to land` });
  };

  const boardWith = async (name: string): Promise<Board> => {
    const created = await postLocal('/workspaces', { name });
    expect(created.status).toBe(200);
    const boardId = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const slug = name.toLowerCase().replace(/[^a-z]+/g, '-');
    const path = join(dataDir, `${slug}.md`);
    writeFileSync(path, `# ${name}\n\nBody.\n`);
    const doc = await postLocal(`/workspaces/${boardId}/docs`, {
      docId: slug,
      type: 'markdown',
      sourceUrl: path,
    });
    expect(doc.status).toBe(200);
    const docId = ((await doc.json()) as { docId: string }).docId;
    const filed = await postLocal(`/workspaces/${encodeURIComponent(boardId)}/docs:attach`, {
      docId: slug,
    });
    expect(filed.status).toBe(200);
    return { boardId, docId };
  };

  const mintShare = async (boardId: string, allowDomains: string[]): Promise<MintedShare> => {
    const res = await postLocal('/api/share/link', { workspaceId: boardId, allowDomains });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { share: MintedShare }).share;
  };

  const baseOptions = (): ServerOptions => ({
    port: 0,
    dataDir,
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
    share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    accessTunnelHosts: [COLLAB_HOST],
  });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'collab-revoke-'));

    // First boot: no share hostname, so the per-share route still mints the
    // records a collaborator is admitted through.
    handle = createServer(baseOptions());
    base = `http://127.0.0.1:${handle.port}`;
    const withShare = async (name: string, allow: string[]) => {
      const board = await boardWith(name);
      return { ...board, share: await mintShare(board.boardId, allow) };
    };
    revoked = await withShare('Revoked board', ['@harborlight.example']);
    const overlapBoard = await boardWith('Overlapped board');
    overlapped = {
      ...overlapBoard,
      domainShare: await mintShare(overlapBoard.boardId, ['@harborlight.example']),
      namedShare: await mintShare(overlapBoard.boardId, [NAMED]),
    };
    untouched = await withShare('Untouched board', ['@saltmarsh.example']);
    switchedOff = await withShare('Switched board', ['@harborlight.example']);
    expiring = await withShare('Expiring board', ['@harborlight.example']);
    alsoLinked = await withShare('Linked board', ['@harborlight.example']);
    await handle.stop();

    // Second boot, the one under test: the same records, plus the share
    // hostname prod has configured.
    handle = createServer({
      ...baseOptions(),
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
    });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('revoking the share closes the collaborator’s socket, and a later write is refused', async () => {
    const collaborator = await asCollaborator(revoked, REVIEWER);
    const shareHost = await asShareHostVisitor(revoked, revoked.share);
    const owner = await asOwner(revoked);
    expect([collaborator.opened, shareHost.opened, owner.opened]).toEqual([true, true, true]);
    // The write path works while access holds, so "refused" below is the
    // revocation and not a socket that could never write.
    await writeLands(collaborator, revoked, 'before revocation');

    const res = await local(`/api/share/${revoked.share.shareId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    // Positive control: the share-hostname visitor, swept by `shareId`.
    expect(await closeCodeWithin(shareHost)).toBe(1008);
    const code = await closeCodeWithin(collaborator);
    expect(await writeAfterRevocation(collaborator, revoked, 'after revocation')).toBe('refused');
    expect(code).toBe(1008);
    // The owner reached the same doc through the whole thing.
    expect(owner.ws.readyState).toBe(WebSocket.OPEN);
    owner.ws.close();
  });

  it('a collaborator another live share still admits keeps their socket', async () => {
    // Both addresses are admitted by the domain share; one of them is ALSO
    // named by a second share on the same board. Revoking the domain share
    // ends one membership and not the other.
    const reviewer = await asCollaborator(overlapped, REVIEWER);
    const named = await asCollaborator(overlapped, NAMED);
    expect([reviewer.opened, named.opened]).toEqual([true, true]);

    const res = await local(`/api/share/${overlapped.domainShare.shareId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    expect(await closeCodeWithin(reviewer)).toBe(1008);
    expect(named.ws.readyState).toBe(WebSocket.OPEN);
    await writeLands(named, overlapped, 'still a member');
    named.ws.close();
  });

  it('a different share’s collaborator stays connected', async () => {
    const guest = await asCollaborator(untouched, GUEST);
    const reviewer = await asCollaborator(expiring, REVIEWER);
    expect([guest.opened, reviewer.opened]).toEqual([true, true]);

    // Revoke a share on another board, which also admits nobody at the
    // guest's domain. The control is that the SAME revocation reaches a
    // socket it should: a collaborator on the board it was minted for.
    const victim = await asCollaborator(alsoLinked, REVIEWER);
    expect(victim.opened).toBe(true);
    const res = await local(`/api/share/${alsoLinked.share.shareId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await closeCodeWithin(victim)).toBe(1008);

    expect(guest.ws.readyState).toBe(WebSocket.OPEN);
    expect(reviewer.ws.readyState).toBe(WebSocket.OPEN);
    guest.ws.close();
    reviewer.ws.close();
  });

  it('turning sharing off closes the collaborator’s socket', async () => {
    const collaborator = await asCollaborator(switchedOff, REVIEWER);
    expect(collaborator.opened).toBe(true);
    // Positive control: a share-link member, whom the switch already hung up.
    await redeemLinkFor(switchedOff.boardId, NAMED);
    const member = await asLinkMember(switchedOff, NAMED);
    expect(member.opened).toBe(true);
    const owner = await asOwner(switchedOff);
    expect(owner.opened).toBe(true);

    try {
      const off = await postLocal('/api/share/enabled', { enabled: false });
      expect(off.status).toBe(200);
      expect(await closeCodeWithin(member)).toBe(1008);
      const code = await closeCodeWithin(collaborator);
      expect(await writeAfterRevocation(collaborator, switchedOff, 'after switch-off')).toBe(
        'refused',
      );
      expect(code).toBe(1008);
      expect(owner.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      expect((await postLocal('/api/share/enabled', { enabled: true })).status).toBe(200);
      owner.ws.close();
    }
  });

  it('the expiry sweep closes the collaborator’s socket once their share lapses', async () => {
    const collaborator = await asCollaborator(expiring, REVIEWER);
    const shareHost = await asShareHostVisitor(expiring, expiring.share);
    expect([collaborator.opened, shareHost.opened]).toEqual([true, true]);

    // A sweep while the share is live leaves both alone.
    handle.sweepDeadShares();
    await writeLands(collaborator, expiring, 'while live');
    expect(collaborator.ws.readyState).toBe(WebSocket.OPEN);

    const record = handle.shares?.list().find((s) => s.shareId === expiring.share.shareId);
    expect(record).toBeTruthy();
    if (record) record.expiresAt = Date.now() - 1;
    handle.sweepDeadShares();

    expect(await closeCodeWithin(shareHost)).toBe(1008);
    expect(await closeCodeWithin(collaborator)).toBe(1008);
  });

  it('removing a share-link member leaves the same person’s collaboration socket open', async () => {
    // One address holding one board two ways: a share admits them on the
    // collaboration hostname, and a redeemed link made them a member on the
    // share hostname. Ending the membership ends that connection; the share
    // still admits the other, so it is not this verb's to close.
    await redeemLinkFor(untouched.boardId, GUEST);
    const collaborator = await asCollaborator(untouched, GUEST);
    const member = await asLinkMember(untouched, GUEST);
    expect([collaborator.opened, member.opened]).toEqual([true, true]);

    const res = await postLocal('/api/share/member/remove', {
      workspaceId: untouched.boardId,
      email: GUEST,
    });
    expect(res.status).toBe(200);
    expect(await closeCodeWithin(member)).toBe(1008);
    expect(collaborator.ws.readyState).toBe(WebSocket.OPEN);
    await writeLands(collaborator, untouched, 'still admitted by the share');
    collaborator.ws.close();
  });
});
