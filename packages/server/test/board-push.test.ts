/**
 * `machine:push-board` between real servers in this process: the Mac's
 * server (the source) and two project machines, Harborlight's and
 * Saltmarsh's, each on a throwaway data dir and each with an Access
 * application of its own.
 *
 * The edge is a stand-in that plays Cloudflare's part. Access turns a service
 * token it admits for that host into a stamp signed for that host's
 * application, naming the token's client id, and the tunnel adds `cf-ray`.
 * Each machine's boot is played by `applyStaged`, run when the machine has
 * staged a push and asked to restart. Nothing leaves loopback: no Fly,
 * Cloudflare, Tigris or prod.
 *
 * What this proves: the push moves the board and archives the source; a
 * second push and a second boot change nothing on the machine, edits made
 * there since included; Saltmarsh's machine takes none of Harborlight's
 * board, whoever sends it; and only a service token's stamp, through the
 * tunnel, for that machine's own application, reaches the route.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { exportBoard } from '../../../infra/project-machine/board-bundle.ts';
import {
  type ImportPlace,
  PUSH_FORMAT,
  applyStaged,
  restartMarker,
  writePushBody,
} from '../../../infra/project-machine/board-import-store.ts';
import { moveBoard } from '../../../infra/project-machine/move-board.ts';
import { pushTarget } from '../../../infra/project-machine/push-board.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'board-push-kid';
const scratch = mkdtempSync(join(tmpdir(), 'cw-board-push-'));

type Sign = (claims: Record<string, unknown>, aud: string) => Promise<string>;
let jwks: JSONWebKeySet;
let sign: Sign;

interface Org {
  label: string;
  host: string;
  aud: string;
  token: { clientId: string; clientSecret: string };
  place: ImportPlace;
  server: ServerHandle | null;
}

const org = (label: string): Org => {
  const dataDir = join(scratch, `${label}-data`);
  mkdirSync(dataDir, { recursive: true });
  return {
    label,
    host: `${label}-workspaces.board.test`,
    aud: `aud-${label}`,
    token: { clientId: `test-${label}.access`, clientSecret: `test-secret-${crypto.randomUUID()}` },
    place: { root: join(scratch, `${label}-imports`), dataDir, boards: [] },
    server: null,
  };
};

const harbor = org('harborlight');
const salt = org('saltmarsh');

function boot(o: Org): ServerHandle {
  o.server = createServer({
    port: 0,
    dataDir: o.place.dataDir,
    cfAccess: {
      teamDomain: TEAM_DOMAIN,
      audience: o.aud,
      hostAudiences: new Map([[o.host, o.aud]]),
      jwks,
    },
    share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    boardImport: { dir: o.place.root, boards: o.place.boards },
  });
  return o.server;
}

/** The machine's boot when it has staged a push: stop, import, start. */
async function rebootIfAsked(o: Org): Promise<void> {
  if (!existsSync(restartMarker(o.place.root))) return;
  await o.server?.stop();
  applyStaged(o.place);
  boot(o);
}

/** Cloudflare in front of `o`'s hostname: Access admits `o`'s token only. */
function edge(o: Org) {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const id = headers.get('cf-access-client-id');
    const secret = headers.get('cf-access-client-secret');
    if (id !== o.token.clientId || secret !== o.token.clientSecret) {
      return new Response('Forbidden', { status: 403 });
    }
    headers.delete('cf-access-client-id');
    headers.delete('cf-access-client-secret');
    headers.set('cf-access-jwt-assertion', await sign({ common_name: id }, o.aud));
    headers.set('cf-ray', '8a1b2c3d4e5f-SJC');
    headers.set('host', o.host);
    const u = new URL(url);
    return fetch(`http://127.0.0.1:${o.server?.port}${u.pathname}${u.search}`, {
      ...init,
      headers,
    });
  };
}

const tokenHeaders = (o: Org) => ({
  'cf-access-client-id': o.token.clientId,
  'cf-access-client-secret': o.token.clientSecret,
});

/** Straight to `o`'s server with `headers`, as the tunnel would deliver it. */
const direct = (o: Org, path: string, headers: Record<string, string>, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${o.server?.port}${path}`, {
    ...init,
    headers: { host: o.host, ...headers },
  });

function api(server: ServerHandle) {
  const host = `localhost:${server.port}`;
  return async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { host, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
}

let source: ServerHandle;
const sourceDir = join(scratch, 'mac-data');
let boardId = '';
let saltBoard = '';

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = (await exportJWK(publicKey)) as JWK;
  Object.assign(jwk, { kid: KID, alg: 'RS256', use: 'sig' });
  jwks = { keys: [jwk] };
  sign = (claims, aud) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(privateKey);

  mkdirSync(sourceDir, { recursive: true });
  source = createServer({ port: 0, dataDir: sourceDir });
  const src = api(source);
  boardId = (
    (await src('POST', '/workspaces', { name: 'Harborlight' })).workspace as { id: string }
  ).id;
  saltBoard = (
    (await src('POST', '/workspaces', { name: 'Saltmarsh' })).workspace as { id: string }
  ).id;
  await src('POST', `/workspaces/${boardId}/tasks`, {
    assignee: 'Alice',
    title: 'File the Riverbend survey',
  });
  await waitFor(
    () => {
      const p = join(sourceDir, 'workspaces', `${boardId}.tasks.json`);
      return existsSync(p) && readFileSync(p, 'utf8').includes('Riverbend survey') ? true : null;
    },
    { timeout: 15_000, describe: 'the board record on disk' },
  );
  harbor.place = { ...harbor.place, boards: [boardId] };
  salt.place = { ...salt.place, boards: [saltBoard] };
  boot(harbor);
  boot(salt);
});

afterAll(async () => {
  await source?.stop();
  await harbor.server?.stop();
  await salt.server?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

describe('machine:push-board', () => {
  it("refuses Harborlight's board on Saltmarsh's machine, whoever sends it", async () => {
    // Saltmarsh's own token, through its own edge: the board is not one it takes.
    const own = await pushTarget({
      base: `https://${salt.host}`,
      headers: tokenHeaders(salt),
      fetch: edge(salt),
    })
      .holds(boardId)
      .catch((e: Error) => e.message);
    expect(String(own)).toContain('403');
    const res = await edge(salt)(`https://${salt.host}/api/board-import/${boardId}`, {
      method: 'PUT',
      headers: tokenHeaders(salt),
      body: 'x',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'board_not_for_this_machine' });
    // Harborlight's token at Saltmarsh's edge: Access admits it nowhere but its own host.
    const theirs = await edge(salt)(`https://${salt.host}/api/board-import/${saltBoard}`, {
      headers: tokenHeaders(harbor),
    });
    expect(theirs.status).toBe(403);
    // A stamp Harborlight's application signed, carried to Saltmarsh's host.
    const crossed = await direct(salt, `/api/board-import/${saltBoard}`, {
      'cf-ray': '8a1b2c3d4e5f-SJC',
      'cf-access-jwt-assertion': await sign({ common_name: harbor.token.clientId }, harbor.aud),
    });
    expect(crossed.status).toBe(403);
    expect(existsSync(join(salt.place.root, boardId))).toBe(false);
  });

  it('admits only a service token stamp, through the tunnel', async () => {
    const path = `/api/board-import/${boardId}`;
    const stamped = async (claims: Record<string, unknown>) => ({
      'cf-ray': '8a1b2c3d4e5f-SJC',
      'cf-access-jwt-assertion': await sign(claims, harbor.aud),
    });
    // The positive control: the same request with a service token's stamp answers.
    expect((await direct(harbor, path, await stamped({ common_name: 'x.access' }))).status).toBe(
      200,
    );
    // A person's stamp, even one that also names a client id.
    const person = await stamped({ email: 'alice@example.com', common_name: 'x.access' });
    expect((await direct(harbor, path, person)).status).toBe(403);
    // A valid service stamp with no cf-ray: not from the tunnel, so refused,
    // as a process on the machine holding a copied stamp would be.
    const { 'cf-ray': _ray, ...noRay } = await stamped({ common_name: 'x.access' });
    expect((await direct(harbor, path, noRay)).status).toBe(403);
    // Loopback with nothing, as the lead would send it.
    const local = await fetch(`http://127.0.0.1:${harbor.server?.port}${path}`, {
      headers: { host: `localhost:${harbor.server?.port}` },
    });
    expect(local.status).toBe(403);
    // No stamp at all.
    expect((await direct(harbor, path, { 'cf-ray': '8a1b2c3d4e5f-SJC' })).status).toBe(403);
  });

  it('refuses a push whose path leaves its folder, staging nothing', async () => {
    const header = JSON.stringify({
      format: PUSH_FORMAT,
      manifest: {
        format: 'cw-board-bundle-1',
        boardId,
        boardName: 'Harborlight',
        exportedAt: 0,
        docIds: [],
        files: [{ path: '../../escape', sha256: '', bytes: 1 }],
        merges: {},
        bindings: [],
      },
    });
    const res = await edge(harbor)(`https://${harbor.host}/api/board-import/${boardId}`, {
      method: 'PUT',
      headers: tokenHeaders(harbor),
      body: `${header}\nx`,
    });
    expect(res.status).toBe(409);
    expect(String(((await res.json()) as { reason: string }).reason)).toContain('escapes');
    expect(existsSync(restartMarker(harbor.place.root))).toBe(false);
    expect(existsSync(join(scratch, 'escape'))).toBe(false);
  });

  it('moves the board, then a second push and a second boot change nothing', async () => {
    const lines: string[] = [];
    const target = pushTarget({
      base: `https://${harbor.host}`,
      headers: tokenHeaders(harbor),
      fetch: edge(harbor),
      sleep: () => rebootIfAsked(harbor),
      pollMs: 1,
      importTimeoutMs: 50,
    });
    const r = await moveBoard({
      boardId,
      source: { dataDir: sourceDir, base: `http://127.0.0.1:${source.port}` },
      target,
      log: (l) => lines.push(l),
    });
    expect(lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.archived).toBe(true);
    if (!harbor.server) throw new Error('no machine');
    const machine = api(harbor.server);
    const tasks = (await machine('GET', `/workspaces/${boardId}/tasks?format=json`)).tasks as {
      title: string;
    }[];
    expect(tasks.map((t) => t.title)).toEqual(['File the Riverbend survey']);
    const archived = (await api(source)('GET', `/workspaces/${boardId}?format=json`)).workspace as {
      retiredAt?: number;
    };
    expect(typeof archived.retiredAt).toBe('number');

    // An edit on the machine after the move.
    await machine('POST', `/workspaces/${boardId}/tasks`, {
      assignee: 'Bob',
      title: 'Made on the machine',
    });
    const record = join(harbor.place.dataDir, 'workspaces', `${boardId}.tasks.json`);
    await waitFor(
      () => (readFileSync(record, 'utf8').includes('Made on the machine') ? true : null),
      { timeout: 15_000, describe: 'the machine edit on disk' },
    );
    const before = readFileSync(record, 'utf8');

    // The whole move again: refused before anything is sent.
    await expect(
      moveBoard({
        boardId,
        source: { dataDir: sourceDir, base: `http://127.0.0.1:${source.port}` },
        target,
        log: () => {},
      }),
    ).rejects.toThrow(/already holds/);
    // A whole, valid push of the same board sent anyway.
    const bundle = join(scratch, 'again-bundle');
    const manifest = exportBoard(sourceDir, boardId, bundle);
    const body = join(scratch, 'again.bin');
    writePushBody(bundle, manifest, body);
    const again = await edge(harbor)(`https://${harbor.host}/api/board-import/${boardId}`, {
      method: 'PUT',
      headers: tokenHeaders(harbor),
      body: Bun.file(body),
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { reason: string }).reason).toContain('already holds');
    writeFileSync(restartMarker(harbor.place.root), '');
    await rebootIfAsked(harbor);
    expect(readFileSync(record, 'utf8')).toBe(before);
    const status = (await (
      await edge(harbor)(`https://${harbor.host}/api/board-import/${boardId}`, {
        headers: tokenHeaders(harbor),
      })
    ).json()) as { state: string; holds: boolean };
    expect(status).toMatchObject({ state: 'imported', holds: true });
  });
});
