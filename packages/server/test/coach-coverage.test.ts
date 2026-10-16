/**
 * The coach sees his whole day: a comment he posts from his phone's browser
 * and a prompt he types through Remote Control both reach the coach
 * session's next digest, with the comment's text and the prompt said in a
 * few words with its repo and board. Both happen while the coach session is
 * away, and the digest goes when its stream comes back. The board they
 * happen on has a share link, which no longer leaves it out. A headless run's
 * prompt does not reach it.
 *
 * The real server and the real UserPromptSubmit hook. The phone is an Access
 * assertion for the owner with a phone's user agent; the Remote Control
 * session is the hook with no board in its launch env, in a session that
 * joined a board with `attach_agent` and holds its stream there. The summariser is a stub; nothing
 * here reaches a model.
 *
 * This is the regression check for the coach's coverage: it fails if either
 * the phone comment or the Remote Control prompt stops reaching the digest,
 * including when the board is shared.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentIdForName } from '@claude-workspaces/core';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { runPromptHook } from '../../plugin/hooks/lib/prompt-mark.ts';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import type { SummaryMark } from '../src/coach/summary.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { openWorkspaceStream } from './agent-stream.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'coach-coverage-kid';
const AUD = 'aud-owner-app';
const OWNER_HOST = 'workspaces.harborlight.test';
const OWNER_EMAIL = ['owner', 'harborlight.test'].join('@');
const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const COACH_NAME = 'Saltmarsh coach';
const SESSION_NAME = 'Riverbend lead';
const COMMENT = 'The berth chart should start at the north quay.';
const PROMPT = 'Draw the Riverbend tide table for the spring tides';
const HEADLESS_PROMPT = 'Summarise the Saltmarsh logs overnight';
const SUMMARY = 'Asked for a spring tide table';
const WINDOW_MS = 300;

let handle: ServerHandle;
let root: string;
let base: string;
let signJwt: () => Promise<string>;
const asked: SummaryMark[][] = [];

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
      .setSubject('cf-access-coach-coverage')
      .sign(privateKey);
  root = mkdtempSync(join(tmpdir(), 'coach-coverage-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  handle = createServer({
    port: 0,
    dataDir,
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: AUD, jwks },
    // A sharing surface, as prod has: without one the whole server sits
    // behind Access and a session on this machine could post nothing.
    shareLinkHosts: ['share.harborlight.test'],
    shareLinkAudience: 'aud-share-app',
    share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    proxiedTrustedHosts: [OWNER_HOST],
    proxiedTrustedEmails: [OWNER_EMAIL],
    ownerEmail: OWNER_EMAIL,
    coachDigestWindowMs: WINDOW_MS,
    coachSummarizer: async (marks) => {
      asked.push([...marks]);
      return marks.map((m) => (m.text === PROMPT ? SUMMARY : null));
    },
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
  resetOwnerIdentities();
});

/** What his phone's browser sends: the owner's Access assertion, a phone's
 *  user agent, from the owner's own pages. */
const phone = async (): Promise<Record<string, string>> => ({
  host: OWNER_HOST,
  'cf-ray': '8a1b2c3d4e5f-SJC',
  'x-forwarded-proto': 'https',
  'cf-access-jwt-assertion': await signJwt(),
  origin: `https://${OWNER_HOST}`,
  'sec-fetch-site': 'same-origin',
  'user-agent': PHONE_UA,
});

/** The coach session's own stream, read frame by frame. */
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
  return { digests, close: () => controller.abort() };
}

describe('the coach digest covers his day', () => {
  it('carries a phone comment and a Remote Control prompt on a shared board, held while the coach was away', async () => {
    const setup = await fetch(`${base}/coach/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await phone()) },
      body: '{}',
    });
    expect(setup.status).toBe(200);
    const goalsUrl = ((await setup.json()) as { url: string }).url;
    const coachBoard = decodeURIComponent(goalsUrl.split('/')[2] ?? '');
    expect(coachBoard).not.toBe('');

    const board = await seedBoard(base, { name: 'Riverbend' });
    // Someone else can reach this board now; his own actions on it still count.
    const shared = await fetch(`${base}/api/share/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: board }),
    });
    expect(shared.status, await shared.clone().text()).toBe(200);
    const created = await fetch(`${base}/workspaces/${board}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Chart the Riverbend berths',
        assignee: SESSION_NAME,
        author: { id: 'agent:test-seed', name: 'Test Seed', kind: 'agent' },
      }),
    });
    const taskId = ((await created.json()) as { task: { id: string } }).task.id;

    // From his phone, while no coach session is there.
    const comment = await fetch(`${base}/workspaces/${board}/docs/task:${taskId}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await phone()) },
      body: JSON.stringify({
        anchor: { kind: 'subject' },
        author: { id: 'anon-phone-1', name: 'Harborlight phone', kind: 'anon' },
        text: COMMENT,
      }),
    });
    expect(comment.status, await comment.clone().text()).toBeLessThan(300);

    // Through Remote Control: a session launched with no board, which joined
    // one with attach_agent and holds its stream there.
    const sessionId = agentIdForName(SESSION_NAME);
    const attached = await fetch(`${base}/workspaces/${board}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: sessionId,
        agentName: SESSION_NAME,
        runtime: 'claude-code-local',
      }),
    });
    expect(attached.status).toBe(200);
    const sessionStream = await openWorkspaceStream(base, board, {}, sessionId);
    const hookEnv = {
      CW_BASE_URL: base,
      CW_AGENT_NAME: SESSION_NAME,
      CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'bridge-riverbend',
    };
    const typed = await runPromptHook(
      JSON.stringify({ prompt: PROMPT, session_id: 's-remote', cwd: '/work/riverbend' }),
      { env: hookEnv, joinedBoard: true },
    );
    expect(typed).toBe(true);
    // A headless run in the same session: nobody typed it.
    const headless = await runPromptHook(
      JSON.stringify({ prompt: HEADLESS_PROMPT, session_id: 's-cron', cwd: '/work/saltmarsh' }),
      {
        env: { CW_BASE_URL: base, CW_AGENT_NAME: SESSION_NAME, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
        joinedBoard: true,
      },
    );
    expect(headless).toBe(true);

    // The window closes with nobody to read it, then the coach comes back.
    const backlog = join(root, 'data', 'coach', 'backlog.json');
    const waiting = () => {
      try {
        return (JSON.parse(readFileSync(backlog, 'utf8')) as { digests: unknown[] }).digests.length;
      } catch {
        return 0;
      }
    };
    await waitFor(() => waiting() > 0);
    const coachId = agentIdForName(COACH_NAME);
    const seated = handle.tasks.setLeadAgent(coachBoard, coachId, {
      actor: { id: coachId, name: COACH_NAME, kind: 'agent' },
    });
    expect(seated.ok).toBe(true);
    const stream = await coachStream(coachBoard, coachId);
    try {
      await waitFor(() => stream.digests().length > 0);
      const digest = stream.digests()[0] ?? {};
      const items = digest.items as Array<Record<string, unknown>>;
      expect(items).toContainEqual(
        expect.objectContaining({ kind: 'comment', boardId: board, text: COMMENT }),
      );
      const sessions = digest.sessions as Array<Record<string, unknown>>;
      expect(sessions).toContainEqual(
        expect.objectContaining({
          boardId: board,
          board: 'Riverbend',
          repo: 'riverbend',
          activity: [expect.objectContaining({ kind: 'prompt', summary: SUMMARY })],
        }),
      );
      expect(JSON.stringify(digest)).not.toContain('saltmarsh');
      expect(JSON.stringify(digest)).not.toContain(HEADLESS_PROMPT);
      expect(asked.flat().map((m) => m.text)).toEqual([PROMPT]);
      await waitFor(() => waiting() === 0);
    } finally {
      stream.close();
      await sessionStream.close();
    }
  }, 30_000);
});
