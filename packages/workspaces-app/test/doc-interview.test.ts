import {
  SPOKEN_PAUSE_DEFAULT,
  type SpokenServerMessage,
} from '@claude-workspaces/core/spoken-reply';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackContext, SpokenCaptureOpts } from '../src/board/spoken-reply-audio.ts';
import type { SpokenSocket } from '../src/board/spoken-reply-client.ts';
import { interviewSetup } from '../src/doc/doc-interview-setup.ts';
import { START_PROMPT } from '../src/doc/doc-interview-view.ts';
import { mountDocInterview } from '../src/doc/doc-interview.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * The planning voice's card on the review doc, driven with the server, the microphone
 * and the speaker replaced: a socket whose frames the test reads and
 * answers, a capture whose frames the test emits, and a playback context
 * that plays nothing.
 */

class FakeSocket implements SpokenSocket {
  binaryType = '';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  send(d: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  json(): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }
  frames(): number {
    return this.sent.filter((d) => typeof d !== 'string').length;
  }
  reply(m: SpokenServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const playback = {
  currentTime: 1,
  state: 'running',
  resume: async () => {},
  destination: {} as AudioNode,
  createBuffer: (_c: number, length: number, sampleRate: number) =>
    ({ length, sampleRate, copyToChannel: () => {} }) as unknown as AudioBuffer,
  createBufferSource: () =>
    ({
      buffer: null,
      connect: () => {},
      start: () => {},
      stop: () => {},
      onended: null,
    }) as unknown as AudioBufferSourceNode,
} as unknown as PlaybackContext;

let scope: MountScope | null = null;
afterEach(() => {
  scope?.dispose();
  scope = null;
  document.body.replaceChildren();
});

function harness(over: { stored?: string; setups?: Array<1 | 2 | 3>; silenceMs?: number } = {}) {
  scope = new MountScope();
  const sockets: FakeSocket[] = [];
  const captures: SpokenCaptureOpts[] = [];
  let stops = 0;
  const view = mountDocInterview({
    docId: 'd-plan',
    workspaceId: 'w-1',
    author: { id: 'u-1', name: 'Alice' },
    scope,
    setups: over.setups ?? [1, 2],
    url: 'ws://board.test/workspaces/w-1/voice/converse',
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    startCapture: async (o) => {
      captures.push(o);
      return { ok: true, capture: { stop: () => void stops++ } };
    },
    captureContext: () => undefined,
    playbackContext: () => playback,
    storage: { getItem: () => over.stored ?? null },
    blocked: () => null,
    ...(over.silenceMs !== undefined ? { silenceMs: over.silenceMs } : {}),
  });
  const socket = (): FakeSocket => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket');
    return s;
  };
  const starts = () =>
    socket()
      .json()
      .filter((m) => m.type === 'start');
  const frame = () => captures[0]?.onFrame(new Int16Array(800), true);
  const text = (sel: string) => view.card.querySelector(sel)?.textContent ?? '';
  return {
    view,
    captures,
    sockets,
    socket,
    starts,
    frame,
    text,
    get stops() {
      return stops;
    },
  };
}

const QUESTION: SpokenServerMessage = {
  type: 'reply',
  spoken: 'I found 4 gaps. First: What goes under Goals?',
  detail: ['1. Goals — empty', '2. Design — placeholder only'],
  asking: true,
  route: 'interview',
};

/** Claude says the reply: its audio starts and ends. */
function speak(h: ReturnType<typeof harness>, m: SpokenServerMessage): void {
  h.socket().reply(m);
  h.socket().reply({ type: 'audio-start', sampleRate: 24_000 });
  h.socket().reply({ type: 'audio-end' });
}

describe('doc interview', () => {
  it('Interview opens the card listening on the doc, in the board’s chosen setup', async () => {
    const h = harness({ stored: '2' });
    h.view.button.click();
    h.socket().open();
    expect(h.view.card.hidden).toBe(false);
    expect(h.view.card.dataset.phase).toBe('listening');
    expect(h.text('.doc-interview-question')).toBe(START_PROMPT);
    expect(h.starts()).toEqual([
      {
        type: 'start',
        setup: 2,
        mode: 'tap',
        context: { surface: 'doc', docId: 'd-plan' },
        author: { id: 'u-1', name: 'Alice' },
        pause: SPOKEN_PAUSE_DEFAULT,
      },
    ]);
    await vi.waitFor(() => expect(h.captures).toHaveLength(1));
    h.frame();
    expect(h.socket().frames()).toBe(1);
  });

  it('after a question is said it listens again by itself, and sends nothing while Claude talks', async () => {
    const h = harness();
    h.view.button.click();
    h.socket().open();
    await vi.waitFor(() => expect(h.captures).toHaveLength(1));
    h.socket().reply({ type: 'turn-end', text: 'interview me' });
    expect(h.view.card.dataset.phase).toBe('thinking');
    h.socket().reply(QUESTION);
    expect(h.text('.doc-interview-question')).toBe(QUESTION.spoken);
    expect(h.view.card.querySelectorAll('.doc-interview-detail li')).toHaveLength(2);
    h.socket().reply({ type: 'audio-start', sampleRate: 24_000 });
    h.frame();
    expect(h.socket().frames()).toBe(0);
    h.socket().reply({ type: 'audio-end' });
    await vi.waitFor(() => expect(h.starts()).toHaveLength(2));
    expect(h.view.card.dataset.phase).toBe('listening');
    h.frame();
    expect(h.socket().frames()).toBe(1);
    for (const b of h.view.commands) expect(b.disabled).toBe(false);
  });

  it('a reply talking the question over keeps the question on the card, and listens after it', async () => {
    const h = harness();
    h.view.button.click();
    h.socket().open();
    speak(h, QUESTION);
    await vi.waitFor(() => expect(h.starts()).toHaveLength(2));
    h.socket().reply({ type: 'turn-end', text: 'What do you mean by goals?' });
    speak(h, {
      type: 'reply',
      spoken: 'I mean what the plan is for, in a sentence.',
      detail: [],
      asking: true,
      route: 'interview',
      question: 'What goes under Goals?',
    });
    expect(h.text('.doc-interview-question')).toBe('What goes under Goals?');
    expect(
      Array.from(h.view.card.querySelectorAll('.doc-interview-detail li')).map(
        (l) => l.textContent,
      ),
    ).toEqual(['I mean what the plan is for, in a sentence.']);
    await vi.waitFor(() => expect(h.starts()).toHaveLength(3));
    expect(h.view.card.dataset.phase).toBe('listening');
  });

  it.each([
    ['Skip', 'skip'],
    ['Later', 'come back to that'],
    ['Finish', 'that’s enough'],
  ])('%s says "%s" for you', async (label, said) => {
    const h = harness();
    h.view.button.click();
    h.socket().open();
    speak(h, QUESTION);
    await vi.waitFor(() => expect(h.starts()).toHaveLength(2));
    const b = h.view.commands.find((c) => c.textContent === label);
    b?.click();
    expect(h.socket().json().at(-1)).toEqual({ type: 'say', text: said });
    expect(h.view.card.dataset.phase).toBe('thinking');
  });

  it('the interview’s end stops the listening, and the commands go quiet', async () => {
    const h = harness();
    h.view.button.click();
    h.socket().open();
    speak(h, QUESTION);
    await vi.waitFor(() => expect(h.starts()).toHaveLength(2));
    speak(h, {
      type: 'reply',
      spoken: 'Stopping here. 1 of 4 gaps filled.',
      detail: [],
      asking: false,
      route: 'interview',
    });
    await vi.waitFor(() => expect(h.view.card.dataset.phase).toBe('done'));
    expect(h.starts()).toHaveLength(2);
    for (const b of h.view.commands) expect(b.disabled).toBe(true);
    expect(h.view.primary.textContent).toBe('Talk');
  });

  it('Done ends an answer by hand; closing mid-interview ends it on the server', async () => {
    const h = harness();
    h.view.button.click();
    h.socket().open();
    speak(h, QUESTION);
    await vi.waitFor(() => expect(h.starts()).toHaveLength(2));
    expect(h.view.primary.textContent).toBe('Done');
    h.view.primary.click();
    expect(h.socket().json().at(-1)).toEqual({ type: 'end' });
    h.view.close.click();
    expect(h.socket().json().at(-1)).toEqual({ type: 'say', text: 'that’s enough' });
    expect(h.view.card.hidden).toBe(true);
    expect(h.stops).toBe(1);
  });

  it('closing closes the socket, so the next Talk starts on a fresh one', async () => {
    const h = harness();
    h.view.button.click();
    h.socket().open();
    h.view.close.click();
    expect(h.sockets[0]?.readyState).toBe(3);
    h.view.button.click();
    expect(h.sockets).toHaveLength(2);
    h.socket().open();
    expect(h.starts()).toHaveLength(1);
    expect(h.view.card.dataset.phase).toBe('listening');
  });
});

describe('doc interview: always on', () => {
  it('nobody says "interview me": the card opens on the plan prompt and listens', () => {
    const h = harness();
    h.view.button.click();
    h.socket().open();
    expect(h.view.button.textContent).toBe('Talk');
    expect(h.text('.doc-interview-question')).toBe(START_PROMPT);
    expect(START_PROMPT).not.toContain('interview me');
    expect(h.view.card.dataset.phase).toBe('listening');
  });

  it('a silence on opening ends the turn, so the server can ask at that pause', async () => {
    const h = harness({ silenceMs: 10 });
    h.view.button.click();
    h.socket().open();
    await vi.waitFor(() =>
      expect(
        h
          .socket()
          .json()
          .filter((m) => m.type === 'end'),
      ).toHaveLength(1),
    );
  });

  it('when Claude says nothing after an answer, the card listens again at once', async () => {
    const h = harness();
    h.view.button.click();
    h.socket().open();
    speak(h, QUESTION);
    await vi.waitFor(() => expect(h.starts()).toHaveLength(2));
    h.socket().reply({ type: 'turn-end', text: 'I don’t know yet' });
    h.socket().reply({ type: 'reply', spoken: '', detail: [], asking: true, route: 'interview' });
    expect(h.starts()).toHaveLength(3);
    expect(h.view.card.dataset.phase).toBe('listening');
    expect(h.text('.doc-interview-note')).toBe('');
  });
});

describe('doc interview: silence after a question', () => {
  const ends = (h: ReturnType<typeof harness>) =>
    h
      .socket()
      .json()
      .filter((m) => m.type === 'end').length;

  it('ends the turn once when nothing is heard, and then waits', async () => {
    const h = harness({ silenceMs: 10 });
    h.view.button.click();
    h.socket().open();
    speak(h, QUESTION);
    await vi.waitFor(() => expect(ends(h)).toBe(1));
    expect(h.view.card.dataset.phase).toBe('thinking');
    h.socket().reply({ type: 'turn-end', text: '' });
    speak(h, { ...QUESTION, spoken: 'Still there? Say skip to move on, or answer: Goals?' });
    await vi.waitFor(() => expect(h.starts()).toHaveLength(3));
    // The offer was the silence turn; this listen waits for speech.
    await new Promise((r) => setTimeout(r, 40));
    expect(ends(h)).toBe(1);
    expect(h.view.card.dataset.phase).toBe('listening');
  });

  it('speech before the wait runs out keeps the turn open', async () => {
    const h = harness({ silenceMs: 250 });
    h.view.button.click();
    h.socket().open();
    speak(h, QUESTION);
    await vi.waitFor(() => expect(h.starts()).toHaveLength(2));
    h.socket().reply({ type: 'heard', text: 'Twenty minute' });
    await new Promise((r) => setTimeout(r, 400));
    expect(ends(h)).toBe(0);
  });

  it('setup 3 leaves silence to Gemini', async () => {
    const h = harness({ silenceMs: 10, setups: [3] });
    h.view.button.click();
    h.socket().open();
    speak(h, QUESTION);
    await vi.waitFor(() => expect(h.starts()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 40));
    expect(ends(h)).toBe(0);
  });
});

describe('interviewSetup', () => {
  it('takes the board’s choice when this server runs it, else the first it runs', () => {
    expect(interviewSetup([1, 2, 3], '3')).toBe(3);
    expect(interviewSetup([1, 3], '2')).toBe(1);
    expect(interviewSetup([3], null)).toBe(3);
    expect(interviewSetup([], '1')).toBeNull();
    // Setup 4's turns go to an agent session, not the interview.
    expect(interviewSetup([1, 4], '4')).toBe(1);
    expect(interviewSetup([4], '4')).toBeNull();
  });
});
