/**
 * The coach through the real server and its admission gate.
 *
 * Every page route is the owner's alone: an Access assertion for the owner email
 * from this server's own pages, proven the way `inbox-routes.test.ts` proves
 * it. Setup makes a real bound doc on a real board; the where-I-am signal is
 * checked against that board; the stream is an event stream for him and a
 * refusal for anyone else. A moment is raised by a process on this machine,
 * the coach session, and checked against the goals before a page sees it.
 * No session is attached, so nothing here reaches a model.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { GOALS_DOC } from './coach-fixtures.ts';
import { landingFrames } from './landing-frames.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'coach-routes-kid';
const OWNER_AUD = 'aud-owner-app';
const SHARE_AUD = 'aud-share-app';
const SHARE_HOST = 'share.harborlight.test';
const OWNER_HOST = 'workspaces.harborlight.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const OWNER_EMAIL = ['owner', 'harborlight.test'].join('@');
const SAME_ORIGIN = { origin: `https://${OWNER_HOST}`, 'sec-fetch-site': 'same-origin' };

let jwks: JSONWebKeySet;
let signJwt: (aud: string, email: string) => Promise<string>;
let handle: ServerHandle;
let root: string;
let base: string;
let goalsUrl: string;

const req = (path: string, host: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
  });
const local = () => `localhost:${handle.port}`;

const ownerHeaders = async (browser: Record<string, string> = SAME_ORIGIN) => ({
  ...CF_RAY,
  'x-forwarded-proto': 'https',
  'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL),
  ...browser,
});

const landingAsOwner = async () =>
  (await req('/', OWNER_HOST, { headers: await ownerHeaders({}) })).text();

const postJson = (path: string, body: unknown, headers: Record<string, string>, host: string) =>
  req(path, host, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

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
      .setSubject('cf-access-coach')
      .sign(privateKey);

  root = mkdtempSync(join(tmpdir(), 'coach-routes-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
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
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
  resetOwnerIdentities();
});

const ids = () => {
  const m = goalsUrl.match(/^\/workspaces\/([^/]+)\/docs\/([^/]+)$/);
  return { workspaceId: decodeURIComponent(m?.[1] ?? ''), docId: decodeURIComponent(m?.[2] ?? '') };
};

describe('Your coach on the front page, and setup', () => {
  it('offers setup to the owner and nothing to an agent here', async () => {
    expect(await landingAsOwner()).toContain('data-act="setup"');
    expect(await (await req('/', local())).text()).not.toContain('id="coach"');
  });

  it('makes the learning-goals and memory docs once, bound and on their own board', async () => {
    const first = await postJson('/coach/setup', {}, await ownerHeaders(), OWNER_HOST);
    expect(first.status).toBe(200);
    goalsUrl = ((await first.json()) as { url: string }).url;
    const again = await postJson('/coach/setup', {}, await ownerHeaders(), OWNER_HOST);
    expect(((await again.json()) as { url: string }).url).toBe(goalsUrl);
    const { workspaceId, docId } = ids();
    const list = (await (await req('/workspaces', local())).json()) as {
      boardWorkspaces: { id: string; name: string; docCount: number }[];
    };
    expect(list.boardWorkspaces.find((w) => w.id === workspaceId)).toMatchObject({
      name: 'Coach',
      docCount: 2,
    });
    const doc = (await (
      await req(`/workspaces/${workspaceId}/docs/${docId}?format=json`, local())
    ).json()) as {
      meta: { title: string; sourceUrl: string };
    };
    expect(doc.meta.title).toBe('Learning goals');
    expect(doc.meta.sourceUrl.endsWith(join('data', 'coach', 'learning-goals.md'))).toBe(true);
    const page = await landingAsOwner();
    expect(page).toContain(`href="${goalsUrl}">Learning goals</a>`);
    expect(page).toContain('No goals yet.');
  });

  it('refuses an agent here, another origin, and a share visitor', async () => {
    expect((await postJson('/coach/setup', {}, {}, local())).status).toBe(403);
    const other = await ownerHeaders({
      origin: 'https://riverbend.example',
      'sec-fetch-site': 'cross-site',
    });
    expect((await postJson('/coach/setup', {}, other, OWNER_HOST)).status).toBe(403);
    expect((await postJson('/coach/prefs', { readiness: 'more' }, {}, SHARE_HOST)).status).toBe(
      403,
    );
  });
});

describe('the owner’s settings and answers', () => {
  it('takes a how-readily setting and refuses one that is not offered', async () => {
    const h = await ownerHeaders();
    expect((await postJson('/coach/prefs', { readiness: 'often' }, h, OWNER_HOST)).status).toBe(
      400,
    );
    expect((await postJson('/coach/prefs', { readiness: 'more' }, h, OWNER_HOST)).status).toBe(200);
    expect(await landingAsOwner()).toContain('data-readiness="more" aria-pressed="true"');
  });

  it('tells an open workspaces list that the coach changed, whoever changed it', async () => {
    const feed = landingFrames(await req('/landing/events:stream', local()));
    try {
      const h = await ownerHeaders();
      expect((await postJson('/coach/prefs', { readiness: 'less' }, h, OWNER_HOST)).status).toBe(
        200,
      );
      await waitFor(() => feed.parts().has('coach'), { describe: 'a coach frame' });
      expect(await landingAsOwner()).toContain('data-readiness="less" aria-pressed="true"');
    } finally {
      feed.stop();
    }
  });

  it('takes “no update needed”, and has no moment to answer', async () => {
    const h = await ownerHeaders();
    expect((await postJson('/coach/review', { answer: 'later' }, h, OWNER_HOST)).status).toBe(400);
    expect((await postJson('/coach/review', { answer: 'no-update' }, h, OWNER_HOST)).status).toBe(
      200,
    );
    const answer = await postJson(
      '/coach/moments/cm-aaaaaaaaaaaa/answer',
      { answer: 'up' },
      h,
      OWNER_HOST,
    );
    expect(answer.status).toBe(404);
    const bad = await postJson(
      '/coach/moments/cm-aaaaaaaaaaaa/answer',
      { answer: 'yes' },
      h,
      OWNER_HOST,
    );
    expect(bad.status).toBe(400);
  });
});

describe('POST /coach/boards — Coach off for this board', () => {
  it('turns a real board off and on for the owner, and refuses a bad body, an agent and a visitor', async () => {
    const { workspaceId } = ids();
    const h = await ownerHeaders();
    const bad = await postJson(
      '/coach/boards',
      { workspaceId: 'w-none', off: true },
      h,
      OWNER_HOST,
    );
    expect(bad.status).toBe(400);
    const notBool = await postJson('/coach/boards', { workspaceId, off: 'yes' }, h, OWNER_HOST);
    expect(notBool.status).toBe(400);
    expect((await postJson('/coach/boards', { workspaceId, off: true }, {}, local())).status).toBe(
      403,
    );
    expect(
      (await postJson('/coach/boards', { workspaceId, off: true }, {}, SHARE_HOST)).status,
    ).toBe(403);
    expect(
      (await postJson('/coach/boards', { workspaceId, off: true }, h, OWNER_HOST)).status,
    ).toBe(200);
    const page = await landingAsOwner();
    expect(page).toContain('Coach off for:');
    expect(page).toContain(`data-coach-on="${workspaceId}"`);
    expect(
      (await postJson('/coach/boards', { workspaceId, off: false }, h, OWNER_HOST)).status,
    ).toBe(200);
    expect(await landingAsOwner()).not.toContain('Coach off for:');
  });
});

describe('POST /coach/here', () => {
  it('takes a view and a paragraph on a board and doc that exist, refuses the rest, and tells anyone else to stop', async () => {
    const { workspaceId, docId } = ids();
    const h = await ownerHeaders();
    const ok = await postJson(
      '/coach/here',
      { workspaceId, docId, visible: true, heading: 'How', text: 'The passage in view.' },
      h,
      OWNER_HOST,
    );
    expect(ok.status).toBe(200);
    const wrote = await postJson(
      '/coach/here',
      { kind: 'wrote', workspaceId, docId, visible: true, text: 'A paragraph he wrote.' },
      h,
      OWNER_HOST,
    );
    expect(wrote.status).toBe(200);
    const board = await postJson('/coach/here', { workspaceId, visible: false }, h, OWNER_HOST);
    expect(board.status).toBe(200);
    // The front page and the review walk name no board, and say which page.
    for (const page of ['home', 'review']) {
      const res = await postJson('/coach/here', { page, visible: true }, h, OWNER_HOST);
      expect(res.status).toBe(200);
    }
    const cases: unknown[] = [
      { page: 'board', visible: true },
      { page: 'home', kind: 'wrote', visible: true, text: 'no doc' },
      { page: 'home' },
      { workspaceId: 'w-nowhere', visible: true },
      { workspaceId, docId: 'd-not-on-it', visible: true },
      { workspaceId, docId, visible: 'yes' },
      { workspaceId, docId, visible: true, text: 7 },
      { kind: 'shout', workspaceId, docId, visible: true },
      { kind: 'wrote', workspaceId, visible: true, text: 'no doc' },
      { workspaceId: '../etc', visible: true },
    ];
    for (const body of cases)
      expect((await postJson('/coach/here', body, h, OWNER_HOST)).status).toBe(400);
    // Not the owner: an empty answer that tells the page to stop, not a refusal.
    expect(
      (await postJson('/coach/here', { workspaceId, visible: true }, {}, local())).status,
    ).toBe(204);
    // The owner's cookie from another site is still refused.
    const cross = await postJson(
      '/coach/here',
      { workspaceId, visible: true },
      { ...h, 'sec-fetch-site': 'cross-site' },
      OWNER_HOST,
    );
    expect(cross.status).toBe(403);
  });
});

describe('GET /coach/coverage — this machine only, counts only', () => {
  const day = () => new Date().toISOString().slice(0, 10);

  it('answers one local day hour by hour on loopback, with the refused page signals counted', async () => {
    const bad = await postJson('/coach/here', { page: 'board' }, await ownerHeaders(), OWNER_HOST);
    expect(bad.status).toBe(400);
    const res = await req(`/coach/coverage?date=${day()}&timeZone=UTC`, local());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      date: string;
      timeZone: string;
      hours: { dropped: Record<string, number> }[];
    };
    expect(body).toMatchObject({ date: day(), timeZone: 'UTC' });
    expect(body.hours).toHaveLength(24);
    expect(body.hours.reduce((n, h) => n + (h.dropped.refused ?? 0), 0)).toBeGreaterThan(0);
  });

  it('refuses a bad day or zone, another method, the edge and a share visitor', async () => {
    for (const q of ['', 'date=2026-02-30', 'date=yesterday', `date=${day()}&timeZone=Mars/Base`]) {
      expect((await req(`/coach/coverage?${q}`, local())).status).toBe(400);
    }
    expect((await req(`/coach/coverage?date=${day()}`, local(), { method: 'POST' })).status).toBe(
      405,
    );
    const edge = await req(`/coach/coverage?date=${day()}`, OWNER_HOST, {
      headers: await ownerHeaders(),
    });
    expect(edge.status).toBe(403);
    const visitor = await req(`/coach/coverage?date=${day()}`, SHARE_HOST, {
      headers: {
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(SHARE_AUD, OWNER_EMAIL),
      },
    });
    expect(visitor.status).toBeGreaterThanOrEqual(400);
  });
});

describe('GET /coach/stream', () => {
  it('is an event stream for the owner’s own page, and refused to anyone else', async () => {
    const own = await req('/coach/stream', OWNER_HOST, {
      headers: { ...(await ownerHeaders({ 'sec-fetch-site': 'same-origin' })) },
    });
    expect(own.status).toBe(200);
    expect(own.headers.get('content-type')).toBe('text/event-stream');
    await own.body?.cancel();
    const cross = await req('/coach/stream', OWNER_HOST, {
      headers: { ...(await ownerHeaders({ 'sec-fetch-site': 'cross-site' })) },
    });
    expect(cross.status).toBe(403);
    expect((await req('/coach/stream', local())).status).toBe(403);
  });

  it('takes the page’s board and doc, and opens for a place it does not know, as the board or the front page', async () => {
    const { workspaceId, docId } = ids();
    const h = await ownerHeaders({ 'sec-fetch-site': 'same-origin' });
    const q = (params: Record<string, string>) =>
      req(`/coach/stream?${new URLSearchParams(params)}`, OWNER_HOST, { headers: h });
    for (const params of [
      { workspaceId },
      { workspaceId, docId },
      { workspaceId: 'w-nowhere' },
      { workspaceId: '../etc' },
      { workspaceId, docId: 'd-not-on-it' },
      { docId },
    ] as Record<string, string>[]) {
      const res = await q(params);
      expect(res.status).toBe(200);
      await res.body?.cancel();
    }
  });
});

describe('POST /coach/moments — the coach session, this machine only', () => {
  const MOMENT = {
    goal: 3,
    matched: 'I start on a solution before',
    observed: 'Designing the importer in a spec that never says why',
    line: 'Hi, I’m noticing the importer design came before any why. Who has the problem?',
  };

  it('refuses the edge, and here refuses a moment with no goal to act on', async () => {
    expect(
      (await postJson('/coach/moments', MOMENT, await ownerHeaders(), OWNER_HOST)).status,
    ).toBe(403);
    expect((await postJson('/coach/moments', MOMENT, {}, OWNER_HOST)).status).toBe(403);
    const res = await postJson('/coach/moments', MOMENT, {}, local());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no-goals' });
  });

  it('with goals, refuses a bad quote, raises a good one to his page, and refuses a second', async () => {
    const { workspaceId, docId } = ids();
    const set = await postJson(
      `/workspaces/${workspaceId}/docs/${docId}/content`,
      { markdown: GOALS_DOC },
      {},
      local(),
    );
    expect(set.status).toBe(200);
    const bad = await postJson(
      '/coach/moments',
      { ...MOMENT, matched: 'solution first' },
      {},
      local(),
    );
    expect(bad.status).toBe(422);
    const raised = await postJson('/coach/moments', MOMENT, {}, local());
    expect(raised.status).toBe(200);
    const { id } = (await raised.json()) as { id: string };
    expect(id).toMatch(/^cm-/);
    expect((await postJson('/coach/moments', MOMENT, {}, local())).status).toBe(409);
    const answerWith = async (body: unknown) =>
      (await postJson(`/coach/moments/${id}/answer`, body, await ownerHeaders(), OWNER_HOST))
        .status;
    expect(await answerWith({ answer: 'maybe' })).toBe(400);
    expect(await answerWith({ answer: 'up', text: 'Good catch' })).toBe(400);
    expect(await answerWith({ answer: 'down', text: 'x'.repeat(1_001) })).toBe(400);
    expect(await answerWith({ answer: 'down', text: 7 })).toBe(400);
    expect(await answerWith({ answer: 'down', text: '  I was writing the why for Bob.  ' })).toBe(
      200,
    );
    expect(await answerWith({ answer: 'up' })).toBe(404);
    expect(await landingAsOwner()).toContain('This week: 1 moment · Helpful 0 · Not helpful 1');
    // A tab loaded before the thumbs still sends the old words, and they count.
    const again = await postJson('/coach/moments', MOMENT, {}, local());
    const second = ((await again.json()) as { id: string }).id;
    const old = await postJson(
      `/coach/moments/${second}/answer`,
      { answer: 'thanks' },
      await ownerHeaders(),
      OWNER_HOST,
    );
    expect(old.status).toBe(200);
    expect(await landingAsOwner()).toContain('This week: 2 moments · Helpful 1 · Not helpful 1');
  });
});
