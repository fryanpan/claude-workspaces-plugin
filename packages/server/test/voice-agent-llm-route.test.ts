/**
 * Setup 4 through the REAL server: the custom-LLM route's refusals, the
 * callback hostname admitting it only while setup 4 is configured, a share
 * visitor refused, and one whole question — the page's socket, a stubbed
 * ElevenLabs conversation, the route call ElevenLabs would make, the voice,
 * and the timing row — end to end.
 *
 * ElevenLabs is a fake socket behind the real adapter, so nothing reaches a
 * vendor. Every credential here is a literal this test invents.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { VOICE_AGENT_LLM_PATH } from '../src/spoken-reply/agent-llm.ts';
import {
  type AgentSocketArgs,
  createElevenLabsAgent,
} from '../src/spoken-reply/elevenlabs-agent.ts';
import { SPOKEN_TIMINGS_FILE } from '../src/spoken-reply/timings.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

const SECRET = 'fixture-llm-secret-0123456789abcdef';
const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'voice-agent-kid';
const SHARE_AUD = 'aud-for-the-share-app';
const OWNER_AUD = 'aud-for-the-owner-app';
const SHARE_HOST = 'share.example.test';
const CALLBACK_HOST = 'callback.example.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const PERSON = { id: 'known-alice', name: 'Alice', kind: 'known' };

interface Frame {
  type: string;
  [k: string]: unknown;
}

/** The ElevenLabs end: every conversation the server opens, drivable. */
const conversations: Array<{ args: AgentSocketArgs; sent: Record<string, unknown>[] }> = [];
const agent = createElevenLabsAgent({
  apiKey: 'placeholder-key',
  agentId: 'agent_fixture01',
  socketFactory: (args) => {
    const c = { args, sent: [] as Record<string, unknown>[] };
    conversations.push(c);
    queueMicrotask(() => args.onOpen());
    return { send: (d) => c.sent.push(JSON.parse(d)), close: () => {} };
  },
});
const down = (m: unknown) => conversations.at(-1)?.args.onMessage(JSON.stringify(m));

const llmBody = (token: string, question: string) =>
  JSON.stringify({
    model: 'claude-workspaces',
    stream: true,
    messages: [
      { role: 'system', content: 'You are the board.' },
      { role: 'user', content: question },
    ],
    elevenlabs_extra_body: { cw_session: token },
  });

describe('setup 4: the custom-LLM route', () => {
  let armed: ServerHandle;
  let unarmed: ServerHandle;
  const dirs: string[] = [];
  let base = '';
  let boardId = '';
  let signJwt: (aud: string, email: string) => Promise<string>;

  const call = (
    server: ServerHandle,
    opts: { host?: string; auth?: string; body?: string; path?: string; edge?: boolean } = {},
  ) =>
    fetch(`http://127.0.0.1:${server.port}${opts.path ?? VOICE_AGENT_LLM_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.host ? { host: opts.host } : {}),
        ...(opts.edge ? CF_RAY : {}),
        ...(opts.auth !== undefined ? { authorization: opts.auth } : {}),
      },
      body: opts.body ?? llmBody('0'.repeat(32), 'status'),
    });

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = (await exportJWK(publicKey)) as JWK;
    publicJwk.kid = KID;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    const jwks: JSONWebKeySet = { keys: [publicJwk] };
    signJwt = (aud, email) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .setSubject('cf-access-voice-visitor')
        .sign(privateKey);
    const spinUp = (withAgent: boolean) => {
      const dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-agent-'));
      dirs.push(dataDir);
      return createServer({
        port: 0,
        dataDir,
        cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
        shareLinkHosts: [SHARE_HOST],
        shareLinkAudience: SHARE_AUD,
        recallCallbackHost: CALLBACK_HOST,
        spokenReply: {
          listener: null,
          voices: { 1: null, 2: null },
          gemini: null,
          agent: withAgent ? { live: agent, llmSecret: SECRET } : null,
        },
      });
    };
    armed = spinUp(true);
    unarmed = spinUp(false);
    base = `http://127.0.0.1:${armed.port}`;
    const ws = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harborlight' }),
    });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    await armed.stop();
    await unarmed.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('refuses a request without its credential, or with the wrong one', async () => {
    const none = await call(armed);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: 'unauthorized' });
    for (const auth of ['', `Bearer ${SECRET.slice(0, -1)}`, `Bearer ${SECRET}0`, SECRET]) {
      const wrong = await call(armed, { auth });
      expect(wrong.status).toBe(401);
    }
  });

  it('refuses a malformed body, and a token no open socket holds', async () => {
    const auth = `Bearer ${SECRET}`;
    for (const body of ['{not json', '[]', JSON.stringify({ messages: [] })]) {
      const r = await call(armed, { auth, body });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'bad_request' });
    }
    const big = await call(armed, { auth, body: `"${'x'.repeat(300 * 1024)}"` });
    expect(big.status).toBe(413);
    const unknown = await call(armed, { auth });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown_session' });
  });

  it('is not there at all while setup 4 is not configured', async () => {
    const local = await call(unarmed, { auth: `Bearer ${SECRET}` });
    expect(local.status).toBe(404);
    expect(await local.json()).toEqual({ error: 'not_found' });
    const edge = await call(unarmed, { host: CALLBACK_HOST, edge: true, auth: `Bearer ${SECRET}` });
    expect(edge.status).toBe(404);
  });

  it('is the one new path the callback hostname admits', async () => {
    // Past the host gate: the route's own 401, not the gate's 404.
    const reached = await call(armed, { host: CALLBACK_HOST, edge: true });
    expect(reached.status).toBe(401);
    expect(await reached.json()).toEqual({ error: 'unauthorized' });
    // Its neighbours stay shut: another method, a near-miss path, the API.
    const get = await fetch(`${base}${VOICE_AGENT_LLM_PATH}`, {
      headers: { host: CALLBACK_HOST, ...CF_RAY },
    });
    expect(get.status).toBe(404);
    for (const path of [`${VOICE_AGENT_LLM_PATH}/`, '/voice-agent/v1/models', '/workspaces']) {
      const r = await call(armed, { host: CALLBACK_HOST, edge: true, path });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'not_found' });
    }
  });

  it('refuses a share visitor, credential or not', async () => {
    armed.shareLinks.addToAudience(boardId, ['reviewer@partner.example'], 'Bryan');
    const minted = await fetch(`${base}/api/share/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: boardId }),
    });
    expect(minted.status, await minted.clone().text()).toBe(200);
    const { link } = (await minted.json()) as { link: { linkId: string } };
    const visitor = {
      host: SHARE_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': await signJwt(SHARE_AUD, 'reviewer@partner.example'),
    };
    const redeemed = await fetch(`${base}/s/${link.linkId}`, {
      headers: visitor,
      redirect: 'manual',
    });
    expect(redeemed.status).toBe(302);
    // Positive control: the visitor really is admitted to their board.
    const board = await fetch(`${base}/workspaces/${boardId}`, { headers: visitor });
    expect(board.status).toBe(200);
    for (const auth of [undefined, `Bearer ${SECRET}`]) {
      const r = await fetch(`${base}${VOICE_AGENT_LLM_PATH}`, {
        method: 'POST',
        headers: {
          ...visitor,
          'content-type': 'application/json',
          ...(auth ? { authorization: auth } : {}),
        },
        body: llmBody('0'.repeat(32), 'status'),
      });
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: string }).error).toBe('out_of_share_scope');
    }
  });

  it('answers a whole question through the agent and logs its timing under setup 4', async () => {
    const page = new WebSocket(`ws://127.0.0.1:${armed.port}/workspaces/${boardId}/voice/converse`);
    page.binaryType = 'arraybuffer';
    const frames: Frame[] = [];
    const audio: number[] = [];
    page.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') frames.push(JSON.parse(ev.data) as Frame);
      else audio.push((ev.data as ArrayBuffer).byteLength);
    });
    await waitFor(() => frames.some((f) => f.type === 'ready'), { describe: 'ready' });
    expect(frames[0]?.setups).toEqual([4]);

    const before = conversations.length;
    page.send(JSON.stringify({ type: 'start', setup: 4, mode: 'tap', author: PERSON }));
    page.send(new Uint8Array(3200));
    await waitFor(
      () => (conversations.at(-1)?.sent.length ?? 0) > 0 && conversations.length > before,
      {
        describe: 'conversation opened',
      },
    );
    const token = String(
      (conversations.at(-1)?.sent[0]?.custom_llm_extra_body as { cw_session?: string })?.cw_session,
    );
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    down({
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: {
        conversation_id: 'conv_fixture',
        user_input_audio_format: 'pcm_16000',
        agent_output_audio_format: 'pcm_24000',
      },
    });
    await waitFor(() => conversations.at(-1)?.sent.some((m) => 'user_audio_chunk' in m), {
      describe: 'held audio forwarded',
    });

    // ElevenLabs' turn-taking calls the question over, then asks for a reply.
    down({
      type: 'user_transcript',
      user_transcription_event: { user_transcript: 'Claude, give me a status update.' },
    });
    const r = await call(armed, {
      host: CALLBACK_HOST,
      edge: true,
      auth: `Bearer ${SECRET}`,
      body: llmBody(token, 'Claude, give me a status update.'),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    const sse = (await r.text()).split('\n\n').filter((e) => e);
    expect(sse.at(-1)).toBe('data: [DONE]');
    const said = JSON.parse(sse[0]?.slice('data: '.length) ?? '{}').choices[0].delta.content;
    expect(String(said)).toStartWith('Harborlight:');

    down({ type: 'audio', audio_event: { audio_base_64: 'AAAAAA==', event_id: 1 } });
    await waitFor(() => frames.some((f) => f.type === 'audio-end'), { describe: 'voice ended' });
    expect(frames.map((f) => f.type).slice(1)).toEqual([
      'heard',
      'turn-end',
      'working',
      'reply',
      'audio-start',
      'audio-end',
    ]);
    expect(frames.find((f) => f.type === 'reply')?.spoken).toBe(said);
    expect(frames.find((f) => f.type === 'audio-start')?.sampleRate).toBe(24000);
    expect(audio).toEqual([4]);

    page.send(
      JSON.stringify({
        type: 'timing',
        delayMs: 1400,
        endpointMs: 600,
        replyMs: 300,
        audioMs: 500,
      }),
    );
    await waitFor(() => frames.some((f) => f.type === 'timings'), { describe: 'timings' });
    const summary = frames.find((f) => f.type === 'timings')?.summary as Record<
      string,
      { n: number; medianMs: number; p90Ms: number; lastMs: number }
    >;
    expect(summary['4']).toEqual({ n: 1, medianMs: 1400, p90Ms: 1400, lastMs: 1400 });
    const served = (await (await fetch(`${base}/workspaces/${boardId}/voice/timings`)).json()) as {
      setups: number[];
      timings: Record<string, { n: number }>;
    };
    expect(served.setups).toEqual([4]);
    expect(served.timings['4']?.n).toBe(1);
    const rows = readFileSync(join(dirs[0] ?? '', SPOKEN_TIMINGS_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows.at(-1)).toMatchObject({
      setup: 4,
      delayMs: 1400,
      endpointMs: 600,
      replyMs: 300,
      audioMs: 500,
    });

    // The socket closing forgets the token: the route can no longer reach it.
    page.close();
    await waitFor(
      async () =>
        (
          await call(armed, {
            auth: `Bearer ${SECRET}`,
            body: llmBody(token, 'status'),
          })
        ).status === 404,
      { describe: 'token revoked on close' },
    );
  });
});
