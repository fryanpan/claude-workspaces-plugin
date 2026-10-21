/**
 * The app voice client against a scripted socket: it reads the seed the
 * server wrote, speaks and resolves when the speaker has played the line,
 * hears turns, writes to the app, and opens again after a drop with the
 * newest token the server sent rather than the one it started with.
 */
import {
  APP_VOICE_CLOSE_IDLE,
  APP_VOICE_CLOSE_LIFETIME,
  APP_VOICE_CLOSE_TOO_MANY,
  APP_VOICE_SEED_ATTR,
  appVoiceSeedJson,
} from '@claude-workspaces/core/app-voice';
import { describe, expect, it } from 'vitest';
import {
  type AppVoicePlayer,
  connectAppVoice,
  readSeed,
  socketUrl,
} from '../src/app-voice/app-voice-client.ts';

const SEED = {
  socket: '/workspaces/w-harbor/docs/d-river/app-voice',
  token: 'first',
  expiresAt: 0,
};

/** A socket that records what the page sent and lets the test answer. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: unknown[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: unknown): void {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }
  /** The socket closes; `code` is what the server closed it with. */
  close(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  /** The server says something. */
  frame(msg: Record<string, unknown>): void {
    this.readyState = 1;
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  ready(): void {
    this.frame({
      type: 'ready',
      voice: 'scripted',
      listen: true,
      say: true,
      outputRate: 24000,
      inputRate: 16000,
    });
  }
  lastSent(): Record<string, unknown> {
    return this.sent.at(-1) as Record<string, unknown>;
  }
}

function playerSpy() {
  const played: number[] = [];
  let drain: (() => void) | null = null;
  const player: AppVoicePlayer = {
    play: (pcm) => played.push(pcm.byteLength),
    drained: () => new Promise((r) => (drain = r)),
    stop: () => {},
  };
  return { player, played, finish: () => drain?.() };
}

async function open(
  opts: { player?: AppVoicePlayer | null; expiresAt?: number; voice?: string } = {},
) {
  FakeSocket.all = [];
  const waits: (() => void)[] = [];
  const voice = connectAppVoice(
    { ...SEED, expiresAt: opts.expiresAt ?? Date.now() + 600_000 },
    {
      WebSocket: FakeSocket as never,
      location: { protocol: 'https:', host: 'board.test' },
      player: opts.player ?? null,
      openMic: async () => ({ stop: () => {} }),
      wait: () => new Promise((r) => waits.push(r)),
    },
    opts.voice ? { voice: opts.voice } : {},
  );
  const sock = FakeSocket.all[0] as FakeSocket;
  sock.ready();
  return { voice: await voice, sock, waits };
}

describe('the app voice client', () => {
  it('reads the seed the server wrote into the page', () => {
    document.head.innerHTML = `<script type="application/json" ${APP_VOICE_SEED_ATTR}>${appVoiceSeedJson(
      { ...SEED, expiresAt: 5 },
    )}</script>`;
    expect(readSeed(document)).toEqual({ ...SEED, expiresAt: 5 });
    document.head.innerHTML = '';
    expect(readSeed(document)).toBeNull();
    expect(socketUrl({ protocol: 'https:', host: 'board.test' }, SEED)).toBe(
      'wss://board.test/workspaces/w-harbor/docs/d-river/app-voice?token=first',
    );
  });

  it('resolves a line once the speaker has played it', async () => {
    const spy = playerSpy();
    const { voice, sock } = await open({ player: spy.player });
    expect(voice.abilities).toEqual({ voice: 'scripted', listen: true, say: true });
    let done: { stopped: boolean } | undefined;
    void voice.speak('Welcome to Riverbend.', { tone: 'warm' }).then((r) => (done = r));
    const asked = sock.lastSent();
    expect(asked).toMatchObject({ type: 'speak', text: 'Welcome to Riverbend.', tone: 'warm' });
    sock.onmessage?.({ data: new Uint8Array(480).buffer });
    sock.frame({ type: 'spoken', id: asked.id, stopped: false });
    await Promise.resolve();
    expect(spy.played).toEqual([480]);
    expect(done).toBeUndefined();
    spy.finish();
    await expect.poll(() => done).toEqual({ stopped: false });
  });

  it('speaks in the voice it connected with unless a line names another', async () => {
    const { voice, sock } = await open({ voice: 'Riverbend' });
    void voice.speak('Welcome to Riverbend.', { tone: 'warm' });
    expect(sock.lastSent()).toMatchObject({ type: 'speak', voice: 'Riverbend', tone: 'warm' });
    void voice.speak('Saltmarsh is next.', { voice: 'Saltmarsh' });
    expect(sock.lastSent()).toMatchObject({ type: 'speak', voice: 'Saltmarsh' });
    const plain = await open();
    void plain.voice.speak('Harborlight.');
    expect(plain.sock.lastSent()).not.toHaveProperty('voice');
  });

  it('hears a turn and writes to the app', async () => {
    const { voice, sock } = await open();
    const heard: string[] = [];
    voice.on('turn-end', (t) => heard.push(t));
    await voice.listen({ mic: false });
    expect(sock.lastSent()).toEqual({ type: 'listen' });
    sock.frame({ type: 'turn-end', text: 'I think so.' });
    expect(heard).toEqual(['I think so.']);
    const said = voice.say('Saltmarsh first');
    const asked = sock.lastSent();
    sock.frame({ type: 'said', id: asked.id, status: 204 });
    expect(await said).toBe(204);
  });

  it('opens again after a drop with the newest token, and listens again', async () => {
    const { voice, sock, waits } = await open();
    await voice.listen({ mic: false });
    sock.frame({ type: 'token', token: 'second', expiresAt: Date.now() + 600_000 });
    sock.close();
    waits.shift()?.();
    await expect.poll(() => FakeSocket.all.length).toBe(2);
    const again = FakeSocket.all[1] as FakeSocket;
    expect(new URL(again.url).searchParams.get('token')).toBe('second');
    again.ready();
    expect(again.lastSent()).toEqual({ type: 'listen' });
    voice.close();
  });

  it.each([
    ['idle', APP_VOICE_CLOSE_IDLE],
    ['too many on this doc', APP_VOICE_CLOSE_TOO_MANY],
  ])('stays closed, and says so, when the server closes it as %s', async (_why, code) => {
    const { voice, sock, waits } = await open();
    let closed = false;
    voice.on('close', () => (closed = true));
    sock.close(code);
    waits.shift()?.();
    await expect.poll(() => closed).toBe(true);
    expect(FakeSocket.all.length).toBe(1);
  });

  it('opens again after the two-hour limit, like any drop', async () => {
    const { voice, sock, waits } = await open();
    sock.close(APP_VOICE_CLOSE_LIFETIME);
    waits.shift()?.();
    await expect.poll(() => FakeSocket.all.length).toBe(2);
    voice.close();
  });

  it('gives up, and says so, once the token it holds has expired', async () => {
    const { voice, sock, waits } = await open({ expiresAt: Date.now() - 1 });
    let closed = false;
    voice.on('close', () => (closed = true));
    sock.close();
    waits.shift()?.();
    await expect.poll(() => closed).toBe(true);
    expect(FakeSocket.all.length).toBe(1);
  });
});
