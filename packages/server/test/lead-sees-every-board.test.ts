/**
 * The plan lead sees every board the owner does (the owner, 2026-10-23: "They
 * should have the same visibility I do"). A board locked private and a board
 * the owner turned the coach off for are still the coach's to skip, but the
 * lead ranks an item on either, the rank orders the owner's Home queue, and
 * the lead's feed of new asks carries asks filed there.
 *
 * The real server, the owner's Access assertion for "Coach off for this
 * board", and the lead's own stream. Fixtures are invented; the repo is
 * public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewPayload } from '@claude-workspaces/core';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import type { CrossReviewQueue } from '../src/cross-review-queue.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'lead-sees-every-board-kid';
const AUD = 'aud-owner-app';
const OWNER_HOST = 'workspaces.harborlight.test';
const OWNER_EMAIL = ['owner', 'harborlight.test'].join('@');
const LEAD = { id: 'agent-team-lead', name: 'Team Lead', kind: 'agent' };
const FILER = { id: 'agent-riverbend', name: 'Riverbend Agent', kind: 'agent' };
const ASK: ReviewPayload = { shape: 'review', headline: 'Does the timetable read right?' };
const WINDOW_MS = 200;

let handle: ServerHandle;
let dataDir: string;
let base: string;
let signJwt: () => Promise<string>;
let callerIs: string | null = null;

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

/** The owner, from his own pages through Access. */
const owner = async (): Promise<Record<string, string>> => ({
  host: OWNER_HOST,
  'cf-ray': '8a1b2c3d4e5f-SJC',
  'x-forwarded-proto': 'https',
  'cf-access-jwt-assertion': await signJwt(),
  origin: `https://${OWNER_HOST}`,
  'sec-fetch-site': 'same-origin',
});

async function board(name: string): Promise<string> {
  const { workspace } = await ok<{ workspace: { id: string } }>(
    send('POST', '/workspaces', { name, author: FILER }),
  );
  return workspace.id;
}

/** A ticket's review item, filed by another board's agent; its queue key. */
async function ticketItem(ws: string, title: string, headline = ASK.headline): Promise<string> {
  const { task } = await ok<{ task: { id: string } }>(
    send('POST', `/workspaces/${ws}/tasks`, {
      title,
      body: 'Agent can publish the timetable so that sailors plan.',
      author: FILER,
    }),
  );
  const { item } = await ok<{ item: { id: string } }>(
    send('POST', `/workspaces/${ws}/tasks/${task.id}/review-items`, {
      review: { ...ASK, headline },
      author: FILER,
    }),
  );
  return `${ws}:task-review:${task.id}:${item.id}`;
}

async function rank(key: string, value: number): Promise<Response> {
  callerIs = LEAD.id;
  const { token } = await ok<{ token: string }>(fetch(`${base}/api/agents/${LEAD.id}/token`));
  return send(
    'POST',
    '/api/review-queue/rank',
    { agentId: LEAD.id, key, rank: value },
    { authorization: `Bearer ${token}` },
  );
}

const queueKeys = async () =>
  (await ok<CrossReviewQueue>(fetch(`${base}/api/review-queue`))).items.map((i) => i.key);

/** The lead's own stream: the keys of every `workspace.new_asks` item.
 *  `headers` opens it the way a session elsewhere would. */
async function leadStream(plan: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const res = await fetch(
    `${base}/workspaces/${encodeURIComponent(plan)}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`,
    { signal: controller.signal, headers: { accept: 'text/event-stream', ...headers } },
  );
  if (!res.ok) throw new Error(`lead stream: HTTP ${res.status}`);
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
  const askKeys = () =>
    text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .flatMap((l) => {
        try {
          const f = JSON.parse(l.slice(6)) as { event?: string; items?: { key: string }[] };
          return f.event === 'workspace.new_asks' ? (f.items ?? []).map((i) => i.key) : [];
        } catch {
          return [];
        }
      });
  return { askKeys, close: () => controller.abort() };
}

let plan = '';
let open = '';
let locked = '';
let coachOff = '';
let localOnly = '';

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
      .setSubject('cf-access-lead-sees-every-board')
      .sign(privateKey);
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'lead-sees-every-board-')));
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
    askFeedWindowMs: WINDOW_MS,
    identifyAgentCaller: async () => ({ ok: true, agentId: callerIs, via: 'session' }),
  });
  base = `http://127.0.0.1:${handle.port}`;
  plan = await board('Saltmarsh plan');
  writeFileSync(join(dataDir, 'review-plan.json'), JSON.stringify({ planWorkspaceId: plan }));
  await ok(send('PUT', `/workspaces/${plan}/lead`, { leadAgentId: LEAD.id, author: LEAD }));
  open = await board('Harborlight');
  locked = await board('Riverbend');
  coachOff = await board('Riverbend ferries');
  localOnly = await board('Saltmarsh records');
  // A folder that stays on this machine, bound onto the board: the board is
  // local-only from then on (`coach/exclusion.ts`, `localOnlyBoard`).
  const records = join(dataDir, 'saltmarsh-records');
  mkdirSync(records, { recursive: true });
  writeFileSync(join(records, 'README.md'), '# Saltmarsh records\n\nKept on this machine.\n');
  await ok(
    send('POST', '/workspaces', {
      folderPath: records,
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
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
  resetOwnerIdentities();
});

describe('the plan lead on a private board and a coach-off board', () => {
  it('ranks an item on either, and the owner’s Home queue follows the rank', async () => {
    const lockedKey = await ticketItem(locked, 'Private ferry timetable');
    const offKey = await ticketItem(coachOff, 'Ferry fares');
    const openKey = await ticketItem(open, 'Harbour timetable');

    const statuses = [(await rank(lockedKey, 1)).status, (await rank(offKey, 2)).status];
    expect((await rank(openKey, 3)).status).toBe(200);
    expect(statuses).toEqual([200, 200]);
    expect((await queueKeys()).slice(0, 3)).toEqual([lockedKey, offKey, openKey]);
  });

  it('a key that names nothing still answers not-found', async () => {
    const res = await rank(`${locked}:task-review:t-none:r-none`, 1);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('not-found');
  });

  it('hears new asks filed on either board, beside one from an ordinary board', async () => {
    const stream = await leadStream(plan);
    try {
      const lockedKey = await ticketItem(locked, 'Private tide table', 'Private tides right?');
      const offKey = await ticketItem(coachOff, 'Ferry winter fares', 'Winter fares right?');
      // The positive control: an ask from a board nothing excludes.
      const openKey = await ticketItem(open, 'Harbour lights', 'Harbour lights right?');
      await waitFor(() => stream.askKeys().includes(openKey), {
        describe: 'the ordinary board’s ask in the lead’s feed',
      });
      await waitFor(
        () => stream.askKeys().includes(lockedKey) && stream.askKeys().includes(offKey),
        {
          describe: 'the private and coach-off boards’ asks in the lead’s feed',
        },
      );
    } finally {
      stream.close();
    }
  }, 30_000);
});

/**
 * "Local-only" promises a board's content stays on this machine, and the
 * lead's seat may be held by a session elsewhere. So the lead hears a
 * local-only board's asks on a stream opened here, and not on one that came
 * through the tunnel.
 */
describe('the plan lead and a local-only board', () => {
  it('hears its asks on a stream on this machine', async () => {
    const stream = await leadStream(plan);
    try {
      const localKey = await ticketItem(localOnly, 'Mooring ledger', 'Mooring ledger right?');
      await waitFor(() => stream.askKeys().includes(localKey), {
        describe: 'the local-only board’s ask in the lead’s feed on this machine',
      });
    } finally {
      stream.close();
    }
  }, 30_000);

  it('does not hear them on a stream through the tunnel, which still hears other boards', async () => {
    const stream = await leadStream(plan, await owner());
    try {
      const localKey = await ticketItem(localOnly, 'Slipway ledger', 'Slipway ledger right?');
      // The positive control, in the same window: an ordinary board's ask.
      const openKey = await ticketItem(open, 'Harbour buoys', 'Harbour buoys right?');
      await waitFor(() => stream.askKeys().includes(openKey), {
        describe: 'the ordinary board’s ask in the lead’s feed through the tunnel',
      });
      expect(stream.askKeys()).not.toContain(localKey);
    } finally {
      stream.close();
    }
  }, 30_000);
});
