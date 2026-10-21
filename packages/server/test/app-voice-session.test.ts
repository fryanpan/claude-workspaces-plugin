/**
 * One app voice socket's session, driven directly with scripted engines:
 * a line cut off by the next one, a cut-in, the limits, the token refresh,
 * and the `say` write's request.
 */
import { describe, expect, it } from 'bun:test';
import type { AppVoiceServerMessage } from '@claude-workspaces/core/app-voice';
import { appSayer } from '../src/app-voice/say.ts';
import { AppVoiceSession } from '../src/app-voice/session.ts';
import { APP_VOICE_TOKEN_REFRESH_MS } from '../src/app-voice/token.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

/** A voice that sends one chunk and then waits until it is stopped or released. */
function heldVoice() {
  const release: (() => void)[] = [];
  const voice: SpokenVoice = {
    name: 'held',
    speak: (_text, onAudio, signal) =>
      new Promise<void>((resolve) => {
        onAudio(new Uint8Array(4));
        release.push(resolve);
        signal?.addEventListener('abort', () => resolve());
      }),
  };
  return { voice, release };
}

function session(opts: {
  voice?: SpokenVoice | null;
  listener?: TranscriptionEngine | null;
  say?: ((text: string) => Promise<number>) | null;
}) {
  const frames: AppVoiceServerMessage[] = [];
  const audio: number[] = [];
  const ticks: (() => void)[] = [];
  let minted = 0;
  const s = new AppVoiceSession({
    voice: opts.voice ?? null,
    listener: opts.listener ?? null,
    say: opts.say ?? null,
    sendJson: (m) => frames.push(m),
    sendAudio: (pcm) => audio.push(pcm.byteLength),
    freshToken: () => ({ token: `t${++minted}`, expiresAt: minted }),
    every: (fn, ms) => {
      expect(ms).toBe(APP_VOICE_TOKEN_REFRESH_MS);
      ticks.push(fn);
      return () => ticks.splice(0);
    },
  });
  s.open();
  return { s, frames, audio, ticks, of: (t: string) => frames.filter((f) => f.type === t) };
}

describe('the app voice session', () => {
  it('stops a line when the next one starts', async () => {
    const { voice } = heldVoice();
    const { s, of } = session({ voice });
    s.onText(JSON.stringify({ type: 'speak', text: 'Welcome to Riverbend.', id: 'a' }));
    s.onText(JSON.stringify({ type: 'speak', text: 'Saltmarsh is next.', id: 'b' }));
    await waitFor(() => of('spoken').length === 1, { describe: 'the first line ended' });
    expect(of('spoken')).toEqual([{ type: 'spoken', id: 'a', stopped: true }]);
    s.onText(JSON.stringify({ type: 'stop' }));
    await waitFor(() => of('spoken').length === 2, { describe: 'the second line stopped' });
  });

  it('stops the line when the listener hears somebody else, and not for its own echo', async () => {
    const { voice } = heldVoice();
    let ears: TranscriptionOpenOpts | undefined;
    const listener: TranscriptionEngine = {
      name: 'scripted',
      async open(opts) {
        ears = opts;
        return { send: () => {}, close: async () => {} };
      },
    };
    const { s, of } = session({ voice, listener });
    s.onText(JSON.stringify({ type: 'listen' }));
    await waitFor(() => ears !== undefined, { describe: 'listener open' });
    s.onText(JSON.stringify({ type: 'speak', text: 'Welcome to the Riverbend pilot.', id: 'a' }));
    ears?.onTurn({ turn: 0, text: 'Welcome to the Riverbend pilot', final: false });
    expect(of('cut-in')).toEqual([]);
    ears?.onTurn({ turn: 1, text: 'Wait, can I ask something first?', final: true });
    expect(of('cut-in')).toEqual([
      { type: 'cut-in', text: 'Wait, can I ask something first?', id: 'a' },
    ]);
    await waitFor(() => of('spoken').length === 1, { describe: 'stopped' });
    expect(of('spoken')).toEqual([{ type: 'spoken', id: 'a', stopped: true }]);
    expect(of('turn-end')).toEqual([
      { type: 'turn-end', text: 'Wait, can I ask something first?' },
    ]);
  });

  it('holds audio sent before the listener has opened, and sends it once it has', async () => {
    let sent = 0;
    let opened: (() => void) | undefined;
    const listener: TranscriptionEngine = {
      name: 'slow',
      open: () =>
        new Promise((resolve) => {
          opened = () => resolve({ send: () => void sent++, close: async () => {} });
        }),
    };
    const { s } = session({ listener });
    s.onText(JSON.stringify({ type: 'listen' }));
    s.onAudio(new Uint8Array(1600));
    s.onAudio(new Uint8Array(1600));
    // Larger than a frame may be: dropped.
    s.onAudio(new Uint8Array(70_000));
    expect(sent).toBe(0);
    opened?.();
    await waitFor(() => sent === 2, { describe: 'buffered frames sent' });
  });

  it('refuses a line too long, a say on a doc with no app, and an engine it lacks', async () => {
    const { voice } = heldVoice();
    const { s, of } = session({ voice });
    s.onText(JSON.stringify({ type: 'speak', text: 'x'.repeat(2001), id: 'a' }));
    s.onText(JSON.stringify({ type: 'say', text: 'Harborlight', id: 'w' }));
    s.onText(JSON.stringify({ type: 'listen' }));
    s.onText('{"type":"dance"}');
    await waitFor(() => of('error').length === 4, { describe: 'four errors' });
    expect(of('error').map((e) => (e as { code: string }).code)).toEqual([
      'too_long',
      'not_an_app',
      'no_listener',
      'bad_message',
    ]);
  });

  it('says what it can do, and sends a fresh token on each refresh until it closes', () => {
    const { s, frames, ticks } = session({ say: async () => 204 });
    expect(frames[0]).toMatchObject({ type: 'ready', voice: null, listen: false, say: true });
    ticks[0]?.();
    ticks[0]?.();
    expect(frames.filter((f) => f.type === 'token')).toEqual([
      { type: 'token', token: 't1', expiresAt: 1 },
      { type: 'token', token: 't2', expiresAt: 2 },
    ]);
    s.close();
    expect(ticks).toEqual([]);
  });
});

describe("the write to an app's dev server", () => {
  const store = (meta: { type: string; sourceUrl?: string } | undefined) => ({
    peekMeta: () => meta as never,
    resolveDocId: (id: string) => id,
  });

  it('posts the text as JSON to the app origin, with nothing that names the reader', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sayer = appSayer(store({ type: 'app', sourceUrl: 'http://127.0.0.1:5173' }), (async (
      url: URL,
      init: RequestInit,
    ) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 202 });
    }) as never)('d');
    expect(await sayer?.('Riverbend')).toBe(202);
    expect(calls[0]?.url).toBe('http://127.0.0.1:5173/say');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      body: '{"text":"Riverbend"}',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
    });
  });

  it('has no write for a doc that is not an app', () => {
    expect(appSayer(store({ type: 'markdown' }))('d')).toBeNull();
    expect(appSayer(store(undefined))('d')).toBeNull();
  });
});
