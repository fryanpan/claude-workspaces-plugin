import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireBoardVoice } from '../src/board/board-voice.ts';
import { frameRms, pcm16ToFloat } from '../src/board/spoken-reply-audio.ts';
import { LATE_STOP_MS, SETUP_KEY } from '../src/board/spoken-reply-client.ts';
import { boardState, mountShell, task } from './support/board-region-harness.ts';
import {
  FakeSocket,
  fakePlayback,
  spokenHarness as harness,
} from './support/spoken-reply-harness.ts';

/**
 * The board mic's spoken reply, driven end to end on the page with the
 * server, the microphone and the speaker replaced (`support/spoken-reply-harness.ts`).
 */

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('spoken reply', () => {
  it('a tap on the mic starts a tapped question at once; letting go ends nothing; a second tap does', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.panel.isOpen()).toBe(true);
    expect(h.label()).toBe('Listening');
    h.frame(true);
    h.frame(true);
    h.socket.open();
    const start = h.socket.json()[0];
    expect(start).toMatchObject({ type: 'start', setup: 1, mode: 'tap' });
    expect(start?.context).toEqual({ taskId: 't-1' });
    expect(h.socket.frames()).toBe(2);
    // Holding is not needed: a release, however late, ends nothing.
    h.tick(5000);
    h.mic.dispatchEvent(new Event('pointerup'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.label()).toBe('Listening');
    h.frame(false);
    expect(h.socket.frames()).toBe(3);
    expect(h.socket.json().some((m) => m.type === 'end')).toBe(false);
    h.mic.dispatchEvent(new Event('pointerdown'));
    expect(h.socket.json().at(-1)).toEqual({ type: 'end' });
    expect(h.captureStops).toBe(1);
    expect(h.label()).toBe('Heard you');
  });

  it('names the page’s agent in each start, read at the press; the board names none', async () => {
    let who = 'harborlight-lead';
    const h = harness({ agent: () => who });
    who = 'riverbend';
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    h.frame(true);
    h.socket.open();
    expect(h.socket.json()[0]).toMatchObject({ type: 'start', agent: 'riverbend' });
    document.body.replaceChildren();
    const board = harness();
    board.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    board.frame(true);
    board.socket.open();
    expect('agent' in (board.socket.json()[0] ?? {})).toBe(false);
  });

  it('Space toggles the same way: one tap listens, the next ends it, and a held key repeats nothing', async () => {
    const h = harness();
    const key = (type: 'keydown' | 'keyup', repeat = false) =>
      document.body.dispatchEvent(
        new KeyboardEvent(type, { code: 'Space', key: ' ', repeat, bubbles: true }),
      );
    key('keydown');
    key('keyup');
    await vi.advanceTimersByTimeAsync(2000);
    h.socket.open();
    expect(h.socket.json()[0]).toMatchObject({ type: 'start', mode: 'tap' });
    expect(h.label()).toBe('Listening');
    key('keydown');
    key('keydown', true);
    key('keydown', true);
    expect(h.socket.json().filter((m) => m.type === 'end')).toHaveLength(1);
    expect(h.socket.json().filter((m) => m.type === 'start')).toHaveLength(1);
    expect(h.label()).toBe('Heard you');
  });

  it('once the question reaches the agent the panel says it is being worked on, cue and all, until the reply', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    h.socket.open();
    h.socket.reply({ type: 'heard', text: 'give me a' });
    expect(h.text()).toContain('give me a');
    expect(h.label()).toBe('Listening');
    h.socket.reply({ type: 'turn-end', text: 'give me a status update' });
    expect(h.label()).toBe('Heard you');
    h.socket.reply({ type: 'working' });
    expect(h.label()).toBe('Sent · working on it');
    // The slow-answer cue opens the voice before the reply: still working.
    h.socket.reply({ type: 'audio-start', sampleRate: 24000 });
    h.socket.audio([4000]);
    expect(h.label()).toBe('Sent · working on it');
    h.socket.reply({
      type: 'reply',
      spoken: 'Harborlight: 3 open.',
      detail: [],
      asking: false,
      route: 'fast-path',
    });
    expect(h.label()).toBe('Speaking');
  });

  it('a tap just after the listener ended the question is taken as the stop it was meant to be', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    h.socket.open();
    h.socket.reply({ type: 'turn-end', text: 'where are we' });
    h.socket.reply({ type: 'working' });
    h.tick(LATE_STOP_MS - 1);
    h.mic.dispatchEvent(new Event('pointerdown'));
    expect(h.socket.json().filter((m) => m.type === 'start')).toHaveLength(1);
    expect(h.label()).toBe('Sent · working on it');
    h.tick(1);
    h.mic.dispatchEvent(new Event('pointerdown'));
    expect(h.socket.json().filter((m) => m.type === 'start')).toHaveLength(2);
    expect(h.label()).toBe('Listening');
  });

  it('writes the reply, speaks it, and logs the delay from the last word to the first audible sample', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    h.socket.open();
    h.frame(true); // the last word, at 1000
    h.tick(300);
    h.socket.reply({ type: 'turn-end', text: 'give me a status update' });
    h.tick(20);
    h.socket.reply({
      type: 'reply',
      spoken: 'Harborlight: 3 open. Waiting on you: 1.',
      detail: ['In progress: “Riverbend import”.'],
      asking: false,
      route: 'fast-path',
    });
    expect(h.label()).toBe('Writing');
    expect(h.text()).toContain('Harborlight: 3 open. Waiting on you: 1.');
    expect(h.panel.root.querySelectorAll('.vr-detail li')).toHaveLength(1);
    h.tick(200);
    h.socket.reply({ type: 'audio-start', sampleRate: 24000 });
    expect(h.label()).toBe('Speaking');
    // Silence first, then the word: the delay runs to the audible sample,
    // scheduled 30 ms ahead of the context clock.
    h.socket.audio([0, 0, 0, 0, 4000]);
    expect(h.play.started).toEqual([1.03]);
    expect(h.panel.root.querySelector('.vr-delay b')?.textContent).toBe('550');
    // The report waits for the reply to finish, so it can carry the notes' leads.
    expect(h.socket.json().some((m) => m.type === 'timing')).toBe(false);
    h.socket.reply({ type: 'audio-end' });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.label()).toBe('Done');
    const timing = h.socket.json().find((m) => m.type === 'timing');
    expect(timing?.endpointMs).toBe(300);
    expect(timing?.replyMs).toBe(20);
    expect(Math.round(Number(timing?.delayMs))).toBe(550);
    expect(timing?.noteLeadMs).toBeUndefined();
  });

  it('speaking while Claude talks stops it', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    h.socket.open();
    h.mic.dispatchEvent(new Event('pointerup'));
    h.socket.reply({ type: 'reply', spoken: 'One. Two.', detail: [], asking: false, route: 'x' });
    h.socket.reply({ type: 'audio-start', sampleRate: 24000 });
    h.socket.audio([4000]);
    h.mic.dispatchEvent(new Event('pointerdown'));
    expect(h.socket.json().map((m) => m.type)).toContain('stop');
    expect(h.play.stopped).toBe(1);
    expect(h.label()).toBe('Listening');
    expect(h.text()).toContain('Stopped when you started talking.');
  });

  it('asks one question, offers its choices, and a tapped choice is sent as said', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    h.socket.open();
    h.mic.dispatchEvent(new Event('pointerup'));
    h.socket.reply({
      type: 'reply',
      spoken: 'Which goal: Harborlight or Riverbend?',
      detail: ['Say first or second, or a goal’s name.'],
      asking: true,
      choices: ['Harborlight', 'Riverbend'],
      route: 'fast-path',
    });
    h.socket.reply({ type: 'audio-start', sampleRate: 24000 });
    expect(h.label()).toBe('Asking you');
    h.socket.reply({ type: 'audio-end' });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.label()).toBe('Waiting for your answer');
    const choice = [...h.panel.root.querySelectorAll<HTMLButtonElement>('.vr-choices button')];
    expect(choice.map((b) => b.textContent)).toEqual(['Harborlight', 'Riverbend']);
    choice[1]?.click();
    expect(h.socket.json().at(-1)).toEqual({ type: 'say', text: 'Riverbend' });
    expect(h.label()).toBe('Heard you');
  });

  it('Stop while asking waits for the answer; Stop while speaking stops', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    h.socket.open();
    h.mic.dispatchEvent(new Event('pointerup'));
    h.socket.reply({ type: 'reply', spoken: 'One. Two.', detail: [], asking: false, route: 'x' });
    h.socket.reply({ type: 'audio-start', sampleRate: 24000 });
    const stop = h.panel.root.querySelector<HTMLButtonElement>('.vr-stop');
    expect(stop?.disabled).toBe(false);
    stop?.click();
    expect(h.label()).toBe('Stopped');
    expect(stop?.disabled).toBe(true);
  });

  it('the setup switch: remembered per device, and a setup the server lacks is disabled', () => {
    const h = harness();
    const buttons = [...h.panel.root.querySelectorAll<HTMLButtonElement>('.vr-setups button')];
    expect(buttons.map((b) => b.disabled)).toEqual([false, false, true, true]);
    buttons[1]?.click();
    expect(h.store.get(SETUP_KEY)).toBe('2');
    expect(h.panel.root.querySelector('.vr-setup-name')?.textContent).toBe('Soniox + ElevenLabs');
    buttons[2]?.click();
    expect(h.reply.setup()).toBe(2);
  });

  it('a held setup 2: choosing it says why in one line, and pressing speaks nothing', async () => {
    const line = 'Setup 2 waits on turning off ElevenLabs training.';
    const h = harness({ setups: [1], held: { '2': line } });
    const buttons = [...h.panel.root.querySelectorAll<HTMLButtonElement>('.vr-setups button')];
    expect(buttons.map((b) => b.disabled)).toEqual([false, false, true, true]);
    expect(buttons[1]?.title).toBe(line);
    buttons[1]?.click();
    expect(h.reply.setup()).toBe(2);
    expect(h.panel.root.querySelector('.vr-body')?.textContent).toBe(line);
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(600);
    expect(h.sockets).toEqual([]);
    expect(h.captures).toEqual([]);
    expect(h.panel.root.querySelector('.vr-body')?.textContent).toBe(line);
    // Setup 1 is untouched: it opens the socket and listens.
    buttons[0]?.click();
    h.mic.dispatchEvent(new Event('pointerup'));
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets.length).toBe(1);
    expect(h.label()).toBe('Listening');
  });

  it('an unconfigured setup 4: in the switch, and choosing it names what is missing', async () => {
    const line = 'Setup 4 is not set up on this server yet: it needs the elevenlabs-agent-id card.';
    const h = harness({ setups: [1], held: { '4': line } });
    const buttons = [...h.panel.root.querySelectorAll<HTMLButtonElement>('.vr-setups button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['1', '2', '3', '4']);
    expect(buttons[3]?.disabled).toBe(false);
    buttons[3]?.click();
    expect(h.reply.setup()).toBe(4);
    expect(h.panel.root.querySelector('.vr-setup-name')?.textContent).toBe('ElevenLabs Agents');
    expect(h.panel.root.querySelector('.vr-body')?.textContent).toBe(line);
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(600);
    expect(h.sockets).toEqual([]);
    expect(h.captures).toEqual([]);
  });

  it('opens above the feedback widget’s corner buttons rather than under them', () => {
    const rect = (left: number, top: number, w: number, h: number) =>
      ({ left, top, right: left + w, bottom: top + h, width: w, height: h }) as DOMRect;
    const host = document.createElement('claude-feedback-widget');
    const shadow = host.attachShadow({ mode: 'open' });
    const at = [rect(365, 810, 48, 48), rect(365, 760, 40, 40), rect(700, 100, 40, 40)];
    for (const r of at) {
      const b = document.createElement('button');
      b.getBoundingClientRect = () => r;
      shadow.append(b);
    }
    Object.defineProperty(document.documentElement, 'clientWidth', {
      value: 430,
      configurable: true,
    });
    vi.stubGlobal('innerHeight', 932);
    const h = harness();
    document.body.append(host);
    h.mic.getBoundingClientRect = () => rect(10, 883, 44, 44);
    h.panel.open();
    // Both stacked buttons overlap the panel's column; the one off to the side does not count.
    expect(h.panel.root.style.bottom).toBe(`${932 - 760 + 8}px`);
    expect(h.panel.root.style.width).toBe('398px');
    Reflect.deleteProperty(document.documentElement, 'clientWidth');
  });

  it('a server error is shown and ends the turn', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    h.socket.open();
    h.socket.reply({ type: 'error', message: 'Setup 1 is not set up on this server.' });
    expect(h.label()).toBe('Done');
    expect(h.text()).toContain('Setup 1 is not set up on this server.');
    expect(h.captureStops).toBe(1);
  });
});

describe('spoken-reply audio helpers', () => {
  it('reads loudness and little-endian PCM', () => {
    expect(frameRms(new Int16Array(4))).toBe(0);
    expect(frameRms(new Int16Array([16384, -16384]))).toBeCloseTo(0.5);
    const f = pcm16ToFloat(new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0x01]));
    expect([...f]).toEqual([0.5, -0.5]);
  });
});

describe('wireBoardVoice with the spoken reply', () => {
  function mount(setups: number[], held: Record<string, string> = {}, off?: string) {
    const el = mountShell();
    const opened: FakeSocket[] = [];
    const fetched: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      fetched.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ setups, held, timings: {}, ...(off ? { off } : {}) }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    wireBoardVoice({
      state: boardState({ tasks: new Map([['t-1', task('t-1')]]) }),
      author: { id: 'u-1', name: 'Alice', kind: 'known' },
      workspaceId: 'w-1',
      document,
      location: { origin: 'http://board.test', pathname: '/workspaces/w-1', assign: () => {} },
      el,
      renderDetail: () => {},
      spoken: {
        host: 'board.test',
        protocol: 'http:',
        openSocket: (u) => {
          const s = new FakeSocket();
          (s as unknown as { url: string }).url = u;
          opened.push(s);
          return s;
        },
        startCapture: async () => ({ ok: true, capture: { stop: () => {} } }),
        playbackContext: () => fakePlayback().ctx,
      },
    });
    return { el, opened, fetched };
  }

  it('swaps in the spoken mic when the server names a setup', async () => {
    const m = mount([1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.fetched).toEqual(['/workspaces/w-1/voice/timings']);
    m.el('board-mic').dispatchEvent(new Event('pointerdown'));
    expect(document.getElementById('vr-panel')?.classList.contains('hidden')).toBe(false);
    expect((m.opened[0] as unknown as { url: string }).url).toBe(
      'ws://board.test/workspaces/w-1/voice/converse',
    );
  });

  it('mounts the spoken mic for a held setup alone, so the panel can say why', async () => {
    const line = 'Setup 2 waits on turning off ElevenLabs training.';
    const m = mount([], { '2': line });
    await vi.advanceTimersByTimeAsync(0);
    m.el('board-mic').dispatchEvent(new Event('pointerdown'));
    expect(document.querySelector('#vr-panel .vr-body')?.textContent).toBe(line);
    expect(m.opened).toEqual([]);
  });

  it('says on the plain mic that spoken replies are off by this server’s profile', async () => {
    const off = 'Spoken replies are off on this server.';
    const m = mount([], {}, off);
    await vi.advanceTimersByTimeAsync(0);
    const mic = m.el('board-mic');
    expect(mic.title).toContain(off);
    expect(mic.getAttribute('aria-description')).toBe(off);
    mic.dispatchEvent(new Event('pointerdown'));
    expect(document.getElementById('vr-panel')).toBeNull();
    expect(m.opened).toEqual([]);
  });

  it('keeps the plain mic when the server can speak no setup', async () => {
    const m = mount([]);
    await vi.advanceTimersByTimeAsync(0);
    m.el('board-mic').dispatchEvent(new Event('pointerdown'));
    expect(document.getElementById('vr-panel')).toBeNull();
    expect(m.opened).toEqual([]);
  });
});
