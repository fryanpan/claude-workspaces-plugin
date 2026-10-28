/**
 * A doc bound from a project marked local-only is off for the coach, through
 * the real server, and still takes the plan lead's rank: the lead sees every
 * board the owner does (the owner, 2026-10-23).
 *
 * The privacy check asked the project store about the doc's KEY
 * (`repoKey\0relPath`) where it takes the project's key, so no doc was ever
 * off for its project's privacy, and neither was a board holding one. Here
 * the project is marked local-only over the real route, after the same doc
 * has been seen to reach the coach and to take a rank, so the only thing
 * that changes between the two halves is the project's privacy. A doc from a
 * project that is not local-only, on another board, still reaches the coach
 * afterwards, and both docs still take a rank.
 *
 * The real server, a real git repo per project, the owner's Access assertion
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
import { parseDocKey } from '../src/doc-key.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'coach-local-only-project-kid';
const AUD = 'aud-owner-app';
const OWNER_HOST = 'workspaces.harborlight.test';
const OWNER_EMAIL = ['owner', 'harborlight.test'].join('@');
const COACH_NAME = 'Riverbend coach';
const LEAD = { id: 'agent-team-lead', name: 'Team Lead', kind: 'agent' };
const FILER = { id: 'agent-harborlight', name: 'Harborlight Agent', kind: 'agent' };
const WINDOW_MS = 300;

let handle: ServerHandle;
let root: string;
let base: string;
let signJwt: () => Promise<string>;
let callerIs: string | null = null;

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
      .setSubject('cf-access-coach-local-only')
      .sign(privateKey);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'coach-local-only-project-')));
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
    identifyAgentCaller: async () => ({ ok: true, agentId: callerIs, via: 'session' }),
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

/** An agent asks for review on a doc; the plan lead ranks it by this key. */
async function agentAsks(ws: string, docId: string, find: string, headline: string) {
  const { thread } = await ok<{ thread: { id: string } }>(
    send('POST', `/workspaces/${ws}/docs/${encodeURIComponent(docId)}/threads/by_find`, {
      author: FILER,
      find,
      text: `Riverbend, ${headline}`,
      review: { shape: 'review', headline },
    }),
  );
  return `${ws}:doc-thread:${docId}:${thread.id}`;
}

async function rank(key: string, value: number): Promise<number> {
  callerIs = LEAD.id;
  const { token } = await ok<{ token: string }>(fetch(`${base}/api/agents/${LEAD.id}/token`));
  const res = await send(
    'POST',
    '/api/review-queue/rank',
    { agentId: LEAD.id, key, rank: value },
    { authorization: `Bearer ${token}` },
  );
  return res.status;
}

describe('a doc in a local-only project', () => {
  it('stops reaching the coach once its project is local-only, while another project still does; both still take a rank', async () => {
    // The coach: its board, its seated lead, and that lead's stream.
    const setup = await ok<{ url: string }>(send('POST', '/coach/setup', {}, await owner()));
    const coachBoard = decodeURIComponent(setup.url.split('/')[2] ?? '');
    const coachId = agentIdForName(COACH_NAME);
    const seated = handle.tasks.setLeadAgent(coachBoard, coachId, {
      actor: { id: coachId, name: COACH_NAME, kind: 'agent' },
    });
    expect(seated.ok).toBe(true);
    // The plan lead, on a board of its own.
    const plan = await seedBoard(base, { name: 'Saltmarsh plan' });
    writeFileSync(
      join(root, 'data', 'review-plan.json'),
      JSON.stringify({ planWorkspaceId: plan }),
    );
    await ok(send('PUT', `/workspaces/${plan}/lead`, { leadAgentId: LEAD.id, author: LEAD }));

    const clinic = project('saltmarsh-clinic', 'letters.md', '# Letters\n\nSaltmarsh dosage.\n');
    const harbor = project('harborlight-site', 'post.md', '# Post\n\nHarborlight launch.\n');
    const records = await seedBoard(base, { name: 'Riverbend' });
    const launch = await seedBoard(base, { name: 'Harborlight' });
    const letters = await bind(records, 'letters', join(clinic, 'letters.md'), 'Clinic letters');
    const post = await bind(launch, 'post', join(harbor, 'post.md'), 'Launch post');
    const lettersKey = await agentAsks(records, letters, 'Saltmarsh dosage', 'Letters ready?');
    const postKey = await agentAsks(launch, post, 'Harborlight launch', 'Post ready?');

    const stream = await coachStream(coachBoard, coachId);
    try {
      // Before: the same doc on the same board reaches the coach and takes
      // a rank. This is what the second half is measured against.
      await ownerComments(records, letters, 'Saltmarsh dosage', 'Letters comment, before.');
      await waitFor(() => stream.wire().includes('Letters comment, before.'), {
        describe: 'the letters comment in a digest before the project is local-only',
      });
      expect(await rank(lettersKey, 1)).toBe(200);

      // The project, marked local-only over the real route. The doc's key
      // names that project: the doc is in it.
      const marked = await ok<{ repoKey: string; privacy: string }>(
        send('PUT', '/api/mounts/privacy', { path: clinic, privacy: 'local-only' }),
      );
      expect(marked.privacy).toBe('local-only');
      const key = handle.docStore.repos.primaryKeyFor(letters);
      expect(key ? parseDocKey(key)?.repoKey : undefined).toBe(marked.repoKey);

      const seen = stream.digests().length;
      await ownerComments(records, letters, 'Saltmarsh dosage', 'Letters comment, after.');
      // The positive control, from a project that is not local-only: it is
      // what proves a digest went after the letters comment was made.
      await ownerComments(launch, post, 'Harborlight launch', 'Post comment, after.');
      await waitFor(() => stream.wire().includes('Post comment, after.'), {
        describe: 'the post comment in a digest after the letters project is local-only',
      });
      const after = JSON.stringify(stream.digests().slice(seen));
      expect(after).not.toContain('Letters comment, after.');
      expect(after).not.toContain(letters);
      expect(after).not.toContain(records);
      expect(after).not.toContain('Clinic letters');

      // The plan lead is not the coach: both asks still take a rank.
      expect(await rank(lettersKey, 2)).toBe(200);
      expect(await rank(postKey, 1)).toBe(200);
    } finally {
      stream.close();
    }
  }, 30_000);
});
