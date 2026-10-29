/**
 * The coach hears from every board the owner can see, local-only and
 * sharing-locked boards included; the one board it does not hear from is one
 * he turned off with "Coach off for this board" (the owner, 2026-10-28: "All
 * boards. Team Lead and Coach may have access to everything I have access
 * to.").
 *
 * The real server, a real git repo per board, the owner's Access assertion
 * for his comments, and the coach session's own stream. Nothing here reaches
 * a model. Fixtures are invented; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentIdForName } from '@claude-workspaces/core';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'coach-sees-every-board-kid';
const AUD = 'aud-owner-app';
const OWNER_HOST = 'workspaces.harborlight.test';
const OWNER_EMAIL = ['owner', 'harborlight.test'].join('@');
const COACH_NAME = 'Riverbend coach';
const WINDOW_MS = 300;

let handle: ServerHandle;
let root: string;
let base: string;
let signJwt: () => Promise<string>;

function git(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

/** A repo with an origin and one committed markdown file. */
function project(name: string, file: string, markdown: string): string {
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', `git@github.example:example/${name}.git`);
  writeFileSync(join(repo, file), markdown);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const jwks: JSONWebKeySet = { keys: [jwk] };
  signJwt = () =>
    new SignJWT({ email: OWNER_EMAIL })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-coach-sees-every-board')
      .sign(privateKey);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'coach-sees-every-board-')));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  handle = createServer({
    port: 0,
    dataDir,
    spawnerAgentId: null,
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: AUD, jwks },
    shareLinkHosts: ['share.harborlight.test'],
    shareLinkAudience: 'aud-share-app',
    share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    proxiedTrustedHosts: [OWNER_HOST],
    proxiedTrustedEmails: [OWNER_EMAIL],
    ownerEmail: OWNER_EMAIL,
    coachDigestWindowMs: WINDOW_MS,
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
  resetOwnerIdentities();
});

/** The owner, from his own pages through Access. */
const owner = async (): Promise<Record<string, string>> => ({
  host: OWNER_HOST,
  'cf-ray': '8a1b2c3d4e5f-SJC',
  'x-forwarded-proto': 'https',
  'cf-access-jwt-assertion': await signJwt(),
  origin: `https://${OWNER_HOST}`,
  'sec-fetch-site': 'same-origin',
});

const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function ok<T>(res: Promise<Response>): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json()) as T;
}

/** The coach session's own stream: every `coach.digest` frame it was sent. */
async function coachStream(workspaceId: string, agentId: string) {
  const controller = new AbortController();
  const res = await fetch(
    `${base}/workspaces/${encodeURIComponent(workspaceId)}/events:stream?agentId=${encodeURIComponent(agentId)}`,
    { signal: controller.signal, headers: { accept: 'text/event-stream' } },
  );
  if (!res.ok) throw new Error(`coach stream: HTTP ${res.status}`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let text = '';
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      text += dec.decode(value);
    }
  })();
  const digests = () =>
    text
      .split('\n\n')
      .flatMap((block) => block.split('\n').filter((l) => l.startsWith('data: ')))
      .map((l) => {
        try {
          return JSON.parse(l.slice(6)) as Record<string, unknown>;
        } catch {
          return {};
        }
      })
      .filter((f) => f.event === 'coach.digest');
  return { digests, wire: () => JSON.stringify(digests()), close: () => controller.abort() };
}

/** Bind a repo file onto a board; the doc id the server answers. */
async function bind(ws: string, docId: string, path: string, title: string): Promise<string> {
  const made = await ok<{ docId?: string; meta?: { docId?: string } }>(
    send('POST', `/workspaces/${ws}/docs`, { docId, type: 'markdown', sourceUrl: path, title }),
  );
  return String(made.meta?.docId ?? made.docId);
}

/** The owner comments on a doc; the coach hears his comments' text. */
async function ownerComments(ws: string, docId: string, find: string, text: string) {
  await ok(
    send(
      'POST',
      `/workspaces/${ws}/docs/${encodeURIComponent(docId)}/threads/by_find`,
      { author: { id: 'anon-owner-1', name: 'Harborlight tablet', kind: 'anon' }, find, text },
      await owner(),
    ),
  );
}

interface Boards {
  coachBoard: string;
  coachId: string;
  open: { ws: string; doc: string };
  localOnly: { ws: string; doc: string };
  locked: { ws: string; doc: string };
  coachOff: { ws: string; doc: string };
}

/** The coach and its seated lead, and one board of each kind with a doc on it. */
async function makeBoards(): Promise<Boards> {
  const setup = await ok<{ url: string }>(send('POST', '/coach/setup', {}, await owner()));
  const coachBoard = decodeURIComponent(setup.url.split('/')[2] ?? '');
  const coachId = agentIdForName(COACH_NAME);
  const seated = handle.tasks.setLeadAgent(coachBoard, coachId, {
    actor: { id: coachId, name: COACH_NAME, kind: 'agent' },
  });
  expect(seated.ok).toBe(true);

  const open = await seedBoard(base, { name: 'Harborlight' });
  const localOnly = await seedBoard(base, { name: 'Saltmarsh records' });
  const locked = await seedBoard(base, { name: 'Riverbend' });
  const coachOff = await seedBoard(base, { name: 'Riverbend boats' });
  // A folder kept on this machine, bound onto the board: the board is
  // local-only from then on.
  const kept = join(root, 'saltmarsh-kept');
  mkdirSync(kept);
  writeFileSync(join(kept, 'README.md'), '# Saltmarsh kept\n\nOn this machine.\n');
  await ok(
    send('POST', '/workspaces', {
      folderPath: kept,
      hubWorkspaceId: localOnly,
      privacy: 'local-only',
    }),
  );
  await ok(
    send('POST', '/api/share/lock', {
      workspaceId: locked,
      locked: true,
      reason: 'private',
      actor: { id: 'known-owner', name: 'Owner' },
    }),
  );
  await ok(send('POST', '/coach/boards', { workspaceId: coachOff, off: true }, await owner()));

  const doc = async (ws: string, name: string, line: string) => {
    const repo = project(name, 'notes.md', `# Notes\n\n${line}\n`);
    return { ws, doc: await bind(ws, name, join(repo, 'notes.md'), `${name} notes`) };
  };
  return {
    coachBoard,
    coachId,
    open: await doc(open, 'harborlight-notes', 'Harborlight tides.'),
    localOnly: await doc(localOnly, 'saltmarsh-notes', 'Saltmarsh moorings.'),
    locked: await doc(locked, 'riverbend-notes', 'Riverbend timetable.'),
    coachOff: await doc(coachOff, 'boats-notes', 'Riverbend boat fares.'),
  };
}

let made: Promise<Boards> | undefined;
const boards = () => {
  made ??= makeBoards();
  return made;
};

/**
 * He comments on the turned-off board, then on `place`, then on the ordinary
 * board. The ordinary board's comment arriving proves a digest went after
 * the other two were made; the turned-off board's, made first, would be in
 * it or an earlier one.
 */
async function commentOn(place: 'localOnly' | 'locked', find: string, text: string) {
  const b = await boards();
  const stream = await coachStream(b.coachBoard, b.coachId);
  try {
    const offText = `Fares comment, beside the ${place} board.`;
    await ownerComments(b.coachOff.ws, b.coachOff.doc, 'Riverbend boat fares', offText);
    await ownerComments(b[place].ws, b[place].doc, find, text);
    const control = `Tides comment, after the ${place} board.`;
    await ownerComments(b.open.ws, b.open.doc, 'Harborlight tides', control);
    await waitFor(() => stream.wire().includes(control), {
      describe: 'the ordinary board’s comment in a digest',
    });
    await waitFor(() => stream.wire().includes(text), {
      describe: `the ${place} board’s comment in a digest`,
    });
    const wire = stream.wire();
    expect(wire).toContain(b[place].ws);
    // The positive control: the board he turned off still sends nothing.
    expect(wire).not.toContain(offText);
    expect(wire).not.toContain(b.coachOff.ws);
    expect(wire).not.toContain(b.coachOff.doc);
  } finally {
    stream.close();
  }
}

describe('the coach on every board', () => {
  it('hears his comment on a local-only board, and not on a board he turned off', async () => {
    await commentOn('localOnly', 'Saltmarsh moorings', 'Moorings comment.');
  }, 30_000);

  it('hears his comment on a sharing-locked board, and not on a board he turned off', async () => {
    await commentOn('locked', 'Riverbend timetable', 'Timetable comment.');
  }, 30_000);
});
