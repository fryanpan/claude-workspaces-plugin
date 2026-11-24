/**
 * A server started with a seed board (`seed-board.ts`) has that board, with
 * the named collaborator let in, after its first boot and after every boot
 * since: a collaborator signs in with Google and opens the board, and a second
 * boot makes no second board and drops nobody the owner added by hand.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySeedBoard, parseSeedBoard } from '../src/seed-board.ts';
import type { ServerOptions } from '../src/server-options.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ShareLinks } from '../src/share/share-links.ts';
import {
  CookieJar,
  type GoogleProfile,
  type GoogleStub,
  signInWithGoogle,
  startGoogleStub,
} from './google-stub.ts';

const HOST = 'harborlight-workspaces.example.com';
const ORIGIN = `https://${HOST}`;
const OWNER = 'owner@example.com';
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const BOARD = 'Harborlight sign-in check';
const TUNNEL = { 'cf-ray': '8a1b2c3d4e5f-SJC', 'x-forwarded-proto': 'https' };

const profile = (email: string, name: string): GoogleProfile => ({
  sub: `g-${name.toLowerCase()}`,
  email,
  email_verified: true,
  name,
});

describe('parseSeedBoard', () => {
  it('reads nothing when neither variable is set', () => {
    expect(parseSeedBoard({})).toBeUndefined();
  });

  it('reads a name and addresses, normalized and de-duplicated', () => {
    expect(
      parseSeedBoard({
        CW_SEED_BOARD_NAME: ` ${BOARD} `,
        CW_SEED_BOARD_MEMBERS: 'Alice@Example.com, bob@example.com\nalice@example.com',
      }),
    ).toEqual({ name: BOARD, members: [ALICE, BOB] });
  });

  it('allows a board with nobody added', () => {
    expect(parseSeedBoard({ CW_SEED_BOARD_NAME: BOARD })).toEqual({ name: BOARD, members: [] });
  });

  it('refuses addresses with no board name', () => {
    expect(parseSeedBoard({ CW_SEED_BOARD_MEMBERS: ALICE })).toHaveProperty('error');
  });

  it('refuses a domain or a non-address, and never quotes the value', () => {
    for (const bad of ['@example.com', 'not-an-address']) {
      const res = parseSeedBoard({ CW_SEED_BOARD_NAME: BOARD, CW_SEED_BOARD_MEMBERS: bad });
      expect(res).toHaveProperty('error');
      expect(JSON.stringify(res)).not.toContain(bad);
    }
  });
});

describe('applySeedBoard against a real share-link store', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('creates the board once and adds each address once', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'seed-board-unit-'));
    dirs.push(dataDir);
    const boards: { id: string; name: string }[] = [];
    const ensured: string[] = [];
    const deps = () => ({
      listWorkspaces: () => boards,
      createWorkspace: (name: string) => {
        const b = { id: `ws-${boards.length + 1}`, name };
        boards.push(b);
        return b;
      },
      ensureWorkspace: (id: string) => void ensured.push(id),
      shareLinks: new ShareLinks({ dataDir }),
    });
    const first = applySeedBoard({ name: BOARD, members: [ALICE] }, deps());
    expect(first).toEqual({ workspaceId: 'ws-1', created: true, added: [ALICE] });
    // A fresh store over the same directory, as the next boot reads it.
    const second = applySeedBoard({ name: BOARD, members: [ALICE] }, deps());
    expect(second).toEqual({ workspaceId: 'ws-1', created: false, added: [] });
    expect(boards).toHaveLength(1);
    expect(ensured).toEqual(['ws-1']);
    const links = new ShareLinks({ dataDir });
    expect(links.membersOf('ws-1').map((m) => m.email)).toEqual([ALICE]);
    expect(links.audienceOf('ws-1')?.entries.map((e) => e.match)).toEqual([ALICE]);
  });
});

describe('a server booted with a seed board', () => {
  let dataDir: string;
  let google: GoogleStub;
  let server: ServerHandle | null = null;

  const options = (): ServerOptions => ({
    port: 0,
    dataDir,
    proxiedTrustedHosts: [HOST],
    proxiedTrustedEmails: [OWNER],
    ownerEmail: OWNER,
    seedBoard: { name: BOARD, members: [ALICE] },
    signIn: {
      mode: 'better-auth',
      origin: ORIGIN,
      google: {
        clientId: 'shared-client',
        clientSecret: 'stub-secret',
        endpoints: google.endpoints,
      },
    },
  });
  const boot = async () => {
    await server?.stop();
    server = createServer(options());
  };
  const port = () => {
    if (!server) throw new Error('no server');
    return server.port;
  };
  const viaTunnel = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port()}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { host: HOST, ...TUNNEL, ...((init.headers as Record<string, string>) ?? {}) },
    });
  const local = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port()}${path}`, {
      ...init,
      headers: {
        host: `localhost:${port()}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const seededBoards = async (): Promise<string[]> => {
    const res = await local('/workspaces');
    const body = (await res.json()) as { boardWorkspaces: { id: string; name: string }[] };
    return body.boardWorkspaces.filter((w) => w.name === BOARD).map((w) => w.id);
  };
  /** Sign in with Google as `who`, then ask for the board. */
  const openAs = async (who: GoogleProfile, board: string) => {
    const jar = new CookieJar();
    await signInWithGoogle(viaTunnel, ORIGIN, jar, google, who);
    return viaTunnel(`/workspaces/${board}?format=json`, { headers: { cookie: jar.header() } });
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'seed-board-boot-'));
    google = startGoogleStub();
  });

  afterAll(async () => {
    await server?.stop();
    google.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('has the board after the first boot, with the collaborator as a member', async () => {
    await boot();
    const boards = await seededBoards();
    expect(boards).toHaveLength(1);
    const board = boards[0] ?? '';
    expect(server?.shareLinks.membersOf(board).map((m) => m.email)).toEqual([ALICE]);
    const res = await openAs(profile(ALICE, 'Alice'), board);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(BOARD);
  });

  it('CONTROL: refuses Bob, whom the setting does not name', async () => {
    const [board] = await seededBoards();
    expect((await openAs(profile(BOB, 'Bob'), board ?? '')).status).toBe(401);
  });

  it('after a second boot: one board, the collaborator still in, nobody dropped', async () => {
    const [board] = await seededBoards();
    // The owner lets Bob in by hand; the next boot must keep him.
    server?.shareLinks.addToAudience(board ?? '', [BOB], 'Owner');
    await boot();
    expect(await seededBoards()).toEqual([board ?? '']);
    const audience = server?.shareLinks.audienceOf(board ?? '')?.entries.map((e) => e.match);
    expect(audience).toEqual([ALICE, BOB]);
    expect((await openAs(profile(ALICE, 'Alice'), board ?? '')).status).toBe(200);
    expect((await openAs(profile(BOB, 'Bob'), board ?? '')).status).toBe(200);
  });
});
