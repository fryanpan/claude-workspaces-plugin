/**
 * Tone cues in a lead's spoken answer: `answer_voice` text carrying `[warm]`
 * and `[curious]` reaches the Soniox voice with each cue at the start of the
 * stream it colours, and never reaches a reader or a voice that does not
 * document tags. Soniox is a fake socket and ElevenLabs a fake fetch: no
 * vendor is called and no key is read. Fixture names are the house ones.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { shapedAnswer } from '../src/spoken-reply/answer.ts';
import { carryCues, leadingCues, withoutCues } from '../src/spoken-reply/cues.ts';
import { LEAD_ANSWER_ROUTE } from '../src/spoken-reply/lead-answer.ts';
import { createElevenLabsVoice, createSonioxVoice } from '../src/spoken-reply/tts.ts';
import type { EngineSocketArgs } from '../src/transcribe-assemblyai.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { ANSWER_VOICE_SINCE } from '../src/voice-quick.ts';
import { agentStream } from './agent-voice-stream.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

const CUED = '[warm] Good news, it shipped. [curious] Want me to start the next one?';

describe('cues', () => {
  it('takes cues out of the words a reader sees, and leaves links and footnotes', () => {
    expect(withoutCues(CUED)).toBe('Good news, it shipped. Want me to start the next one?');
    expect(withoutCues('Done [clears throat] , mostly.')).toBe('Done, mostly.');
    expect(withoutCues('See [the plan](https://example.com) and note [1].')).toBe(
      'See [the plan](https://example.com) and note [1].',
    );
  });

  it('reads the cues a line opens with', () => {
    expect(leadingCues('[warm] [calm] Hello.')).toBe('[warm] [calm]');
    expect(leadingCues('Hello [warm] there.')).toBe('');
  });

  it('carries the cue in effect into the next stream unless it opens with its own', () => {
    expect(carryCues(['Plain.', '[warm] It shipped.', 'Tests pass.', '[curious] Next?'])).toEqual([
      'Plain.',
      '[warm] It shipped.',
      '[warm] Tests pass.',
      '[curious] Next?',
    ]);
  });
});

describe('a cued answer, shaped into points', () => {
  it('starts a point at each cue that follows a sentence end', () => {
    const a = shapedAnswer(CUED, LEAD_ANSWER_ROUTE);
    expect(a.points.map((p) => p.say)).toEqual([
      '[warm] Good news, it shipped.',
      '[curious] Want me to start the next one?',
    ]);
  });

  it('keeps a leading cue on the second spoken sentence and out of the written rest', () => {
    const a = shapedAnswer('[warm] It shipped. The tests pass. Three more are queued.', 'x');
    expect(a.points.map((p) => p.say)).toEqual(['[warm] It shipped.', '[warm] The tests pass.']);
    expect(a.detail).toEqual(['Three more are queued.']);
  });

  it('does not count a cue as a word against the spoken cap', () => {
    const forty = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const a = shapedAnswer(`[warm] [calm] ${forty}.`, 'x');
    expect(a.points[0]?.say).toBe(`[warm] [calm] ${forty}.`);
  });
});

describe('ElevenLabs, which documents no tags for Flash v2.5', () => {
  it('is sent the words without the cues', async () => {
    const bodies: string[] = [];
    const voice = createElevenLabsVoice({
      apiKey: 'placeholder-key',
      fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return new Response(new Uint8Array(4));
      }) as unknown as typeof fetch,
    });
    await voice.speak('[warm] It shipped.', () => {}, new AbortController().signal);
    expect(JSON.parse(bodies[0] ?? '{}').text).toBe('It shipped.');
  });
});

const PERSON = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };

interface Frame {
  type: string;
  [k: string]: unknown;
}

describe('a cued answer_voice through the real server, to a fake Soniox socket', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';
  const opened: TranscriptionOpenOpts[] = [];
  /** Every `text` frame the voice sent Soniox, in order. */
  const sonioxText: string[] = [];
  let lead: Awaited<ReturnType<typeof agentStream>> | null = null;

  const listener: TranscriptionEngine = {
    name: 'fake',
    async open(opts) {
      opened.push(opts);
      return { send: () => {}, close: async () => {} };
    },
  };
  // A Soniox TTS server that answers each text frame with one chunk and the end.
  const fakeSoniox = (a: EngineSocketArgs) => {
    queueMicrotask(() => a.onOpen());
    return {
      send: (d: string | Uint8Array) => {
        const msg = JSON.parse(String(d)) as { stream_id?: string; text?: string };
        if (typeof msg.text !== 'string') return;
        sonioxText.push(msg.text);
        queueMicrotask(() => {
          a.onMessage(JSON.stringify({ stream_id: msg.stream_id, audio: 'AAAA' }));
          a.onMessage(JSON.stringify({ stream_id: msg.stream_id, audio: '', audio_end: true }));
        });
      },
      close: () => {},
    };
  };
  const voice = createSonioxVoice({ apiKey: 'placeholder-key', socketFactory: fakeSoniox });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-tone-cues-'));
    handle = createServer({
      port: 0,
      dataDir,
      spokenReply: { listener, voices: { 1: voice, 2: null }, gemini: null },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    handle.tasks.attachAgent(boardId, {
      agentId: 'lead',
      runtime: 'claude-code-local',
      pluginVersion: ANSWER_VOICE_SINCE,
    });
    lead = await agentStream(base, boardId, 'lead');
  });

  afterAll(async () => {
    lead?.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('says each cue at the start of its stream, and shows the page no brackets', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/workspaces/${boardId}/voice/converse`);
    ws.binaryType = 'arraybuffer';
    const frames: Frame[] = [];
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') frames.push(JSON.parse(ev.data) as Frame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('converse socket refused')));
    });
    await waitFor(() => frames.some((f) => f.type === 'ready'), { describe: 'ready' });
    ws.send(JSON.stringify({ type: 'start', setup: 1, mode: 'hold', author: PERSON }));
    await waitFor(() => opened.length > 0, { describe: 'listener opened' });
    opened.at(-1)?.onTurn({ turn: 0, text: 'go research ferry fares to Riverbend', final: true });
    ws.send(JSON.stringify({ type: 'end' }));
    await waitFor(() => handle.tasks.listQueuedVoice(boardId).length > 0, {
      describe: 'request queued for the lead',
    });
    const queueId = handle.tasks.listQueuedVoice(boardId).at(-1)?.id ?? '';
    const before = sonioxText.length;

    const r = await post(`/workspaces/${boardId}/voice-queue/${queueId}/answer`, {
      agentId: 'lead',
      text: CUED,
    });
    expect(await r.json()).toEqual({ ok: true, delivered: true });
    await waitFor(() => sonioxText.length >= before + 2, { describe: 'both points sent' });
    expect(sonioxText.slice(before)).toEqual([
      '[warm] Good news, it shipped.',
      '[curious] Want me to start the next one?',
    ]);
    await waitFor(() => frames.some((f) => f.route === LEAD_ANSWER_ROUTE), {
      describe: 'the answer on the asking page',
    });
    const reply = frames.find((f) => f.route === LEAD_ANSWER_ROUTE);
    expect(reply?.spoken).toBe('Good news, it shipped. Want me to start the next one?');
    ws.close();
  });

  it('writes a typed lead-chat answer without the cues', async () => {
    const res = await post(`/workspaces/${boardId}/lead-chat`, {
      text: 'is the Saltmarsh signup done?',
      author: { id: 'known-alice', name: 'Alice', kind: 'known' },
    });
    expect(res.status).toBe(201);
    const frame = () => lead?.voice.find((v) => v.transcript === 'is the Saltmarsh signup done?');
    await waitFor(() => frame() !== undefined, { describe: 'the lead got the chat message' });
    const queueId = frame()?.queueId ?? '';
    const r = await post(`/workspaces/${boardId}/voice-queue/${queueId}/answer`, {
      agentId: 'lead',
      text: CUED,
    });
    expect(await r.json()).toEqual({ ok: true, delivered: true });
    const snap = (await (await fetch(`${base}/workspaces/${boardId}/lead-chat`)).json()) as {
      messages: Array<{ role: string; text: string }>;
    };
    expect(snap.messages.filter((m) => m.role === 'agent').map((m) => m.text)).toEqual([
      'Good news, it shipped. Want me to start the next one?',
    ]);
  });
});
