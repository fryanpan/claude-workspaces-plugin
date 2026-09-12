import {
  type CaptureMode,
  MAX_SPEAKER_NAME,
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  MEETING_SILENCE_NOTE,
  type MeetingBotState,
  type MeetingBotStatus,
  RECORDING_CONSENT_NOTE,
  isTerminalBotState,
  meetingSocketPath,
  parseMeetingClientMessage,
} from '@claude-workspaces/core';
import type { MeetingTranscriptEvent, NotesMethod } from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomAudioProcessing } from '../src/meeting-audio.ts';
import type { MeetingCaptureStart } from '../src/meeting-audio.ts';
import type { MeetingBotClient } from '../src/meeting-bot-client.ts';
import {
  TRANSCRIPT_KEEP,
  diffTurnWords,
  parseMeetingServerMessage,
  rollTranscript,
} from '../src/meeting-protocol.ts';
import type { MeetingAudioSource } from '../src/meeting-source.ts';
import {
  type MeetingSocket,
  type MeetingStripHandle,
  clipSpeakerName,
  formatElapsed,
  mountMeetingStrip,
} from '../src/meeting-strip.ts';
import { lockDocToReading } from '../src/signin/write-gate.ts';
import type { DocSpeakers } from '../src/speaker-voices.ts';

/**
 * The meeting chrome is the only surface a meeting has, so every way a meeting
 * can fail has to arrive as words in it. These cover the rolling transcript
 * (where a correction has to land on the word already on screen), the clock,
 * each state the strip can be left sitting in, and the two popovers behind the
 * Record button — the start chooser where every choice is made, and the
 * speaker menu that holds the one verb a running meeting has.
 */

describe('rollTranscript', () => {
  const t = (turn: number, text: string, final = false) => ({ turn, text, final });

  it('appends new turns and keeps only the last few', () => {
    let turns = rollTranscript([], t(1, 'one'), 2);
    turns = rollTranscript(turns, t(2, 'two'), 2);
    turns = rollTranscript(turns, t(3, 'three'), 2);
    expect(turns.map((x) => x.text)).toEqual(['two', 'three']);
  });

  it('REPLACES a turn already on screen in place — that is how a correction lands', () => {
    let turns = rollTranscript([], t(1, 'meet on thirsty'), 3);
    turns = rollTranscript(turns, t(2, 'sounds good'), 3);
    turns = rollTranscript(turns, t(1, 'meet on Thursday', true), 3);
    expect(turns.map((x) => x.text)).toEqual(['meet on Thursday', 'sounds good']);
    expect(turns[0]?.final).toBe(true);
  });

  it('drops a correction for a turn that has already rolled off', () => {
    let turns = rollTranscript([], t(1, 'one'), 2);
    turns = rollTranscript(turns, t(2, 'two'), 2);
    turns = rollTranscript(turns, t(3, 'three'), 2);
    // Turn 1 is gone; re-adding it would put an old line at the live end.
    turns = rollTranscript(turns, t(1, 'ONE'), 2);
    expect(turns.map((x) => x.text)).toEqual(['two', 'three']);
  });

  it('keeps three turns by default', () => {
    expect(TRANSCRIPT_KEEP).toBe(3);
  });
});

describe('diffTurnWords', () => {
  it('marks only the word the model changed, not the whole line', () => {
    const words = diffTurnWords('meet on thirsty', 'meet on Thursday');
    expect(words.map((w) => w.text)).toEqual(['meet', 'on', 'Thursday']);
    expect(words.map((w) => w.changed)).toEqual([false, false, true]);
  });

  it('does not flash words that are merely new', () => {
    const words = diffTurnWords('meet on', 'meet on Thursday');
    expect(words.map((w) => w.changed)).toEqual([false, false, false]);
  });

  it('handles a correction that changes the word count', () => {
    const words = diffTurnWords('the check list', 'the checklist');
    expect(words.map((w) => w.text)).toEqual(['the', 'checklist']);
    expect(words.map((w) => w.changed)).toEqual([false, true]);
  });

  it('treats a first partial as all-new', () => {
    expect(diffTurnWords('', 'hello').map((w) => w.changed)).toEqual([false]);
  });
});

describe('formatElapsed', () => {
  it('is mm:ss, zero-padded', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(9_000)).toBe('00:09');
    expect(formatElapsed(65_000)).toBe('01:05');
    expect(formatElapsed(492_000)).toBe('08:12');
  });

  it('keeps counting past an hour rather than wrapping', () => {
    expect(formatElapsed(3_725_000)).toBe('62:05');
  });

  it('never shows a negative clock', () => {
    expect(formatElapsed(-5_000)).toBe('00:00');
  });
});

describe('parseMeetingServerMessage', () => {
  it('accepts the frames the contract defines', () => {
    expect(
      parseMeetingServerMessage(
        JSON.stringify({ type: 'unavailable', reason: 'not_configured', message: 'no key' }),
      ),
    ).toEqual({ type: 'unavailable', reason: 'not_configured', message: 'no key' });
    expect(
      parseMeetingServerMessage(
        JSON.stringify({ type: 'transcript', turn: 2, text: 'hi', final: false }),
      ),
    ).toEqual({ type: 'transcript', turn: 2, text: 'hi', final: false });
    expect(
      parseMeetingServerMessage(
        JSON.stringify({ type: 'transcript', turn: 2, text: 'hi', final: false, speaker: 'A' }),
      ),
    ).toEqual({ type: 'transcript', turn: 2, text: 'hi', final: false, speaker: 'A' });
  });

  it('accepts a notes_progress frame, and drops non-numeric turn ids', () => {
    expect(
      parseMeetingServerMessage(
        JSON.stringify({ type: 'notes_progress', tick: 1, phase: 'composing', turns: [0, 1] }),
      ),
    ).toEqual({ type: 'notes_progress', tick: 1, phase: 'composing', turns: [0, 1] });
    expect(
      parseMeetingServerMessage(
        JSON.stringify({ type: 'notes_progress', tick: 2, phase: 'written', turns: [3, 'x'] }),
      ),
    ).toEqual({ type: 'notes_progress', tick: 2, phase: 'written', turns: [3] });
    // A tick that composed nothing has a phase of its own; the zone returns
    // its words to the stream instead of fading them away.
    expect(
      parseMeetingServerMessage(
        JSON.stringify({ type: 'notes_progress', tick: 3, phase: 'empty', turns: [4] }),
      ),
    ).toEqual({ type: 'notes_progress', tick: 3, phase: 'empty', turns: [4] });
    expect(
      parseMeetingServerMessage(
        JSON.stringify({ type: 'notes_progress', tick: 1, phase: 'later', turns: [] }),
      ),
    ).toBeNull();
  });

  it('returns null for anything malformed rather than throwing', () => {
    expect(parseMeetingServerMessage('not json')).toBeNull();
    expect(parseMeetingServerMessage(JSON.stringify({ type: 'nope' }))).toBeNull();
    expect(parseMeetingServerMessage(new ArrayBuffer(4))).toBeNull();
  });
});

// ---------------------------------------------------------------------------

class FakeSocket implements MeetingSocket {
  sent: Array<string | ArrayBufferView> = [];
  closed = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed += 1;
  }
  serve(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

/** A minimal status the strip can render. */
const botStatus = (state: MeetingBotState, speakers: string[] = []): MeetingBotStatus => ({
  botId: 'b-1',
  docId: 'doc-1',
  state,
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  platform: 'google_meet',
  speakers,
  updatedAt: 1_000,
});

/** The bot lifecycle as the chrome sees it, driven entirely by the test. */
class FakeBot implements MeetingBotClient {
  ready = Promise.resolve();
  isConfigured = true;
  current: MeetingBotStatus | null = null;
  invites: Array<{ url: string; name?: string }> = [];
  leaves = 0;
  /** When set, the next invite rejects with this message. */
  refuse: string | null = null;
  private listeners = new Set<() => void>();
  private wordListeners = new Set<(frame: MeetingTranscriptEvent) => void>();
  destroy(): void {}
  configured(): boolean {
    return this.isConfigured;
  }
  onTranscript(cb: (frame: MeetingTranscriptEvent) => void): () => void {
    this.wordListeners.add(cb);
    return () => this.wordListeners.delete(cb);
  }
  /** One live turn arriving on the doc's stream, as the server sends it. */
  speak(frame: Omit<MeetingTranscriptEvent, 'event' | 'docId' | 'meetingId'>): void {
    const full: MeetingTranscriptEvent = {
      event: 'meeting.transcript',
      docId: 'doc-1',
      meetingId: 'bot-meeting-1',
      ...frame,
    };
    for (const cb of [...this.wordListeners]) cb(full);
  }
  status(): MeetingBotStatus | null {
    return this.current;
  }
  live(): MeetingBotStatus | null {
    return this.current && !isTerminalBotState(this.current.state) ? this.current : null;
  }
  invite(url: string, name?: string): Promise<void> {
    if (this.refuse) return Promise.reject(new Error(this.refuse));
    this.invites.push({ url, ...(name !== undefined ? { name } : {}) });
    return Promise.resolve();
  }
  leave(): Promise<void> {
    this.leaves += 1;
    return Promise.resolve();
  }
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  set(state: MeetingBotState, speakers: string[] = []): void {
    this.current = botStatus(state, speakers);
    for (const cb of [...this.listeners]) cb();
  }
}

interface Harness {
  root: HTMLElement;
  strip: MeetingStripHandle;
  sockets: FakeSocket[];
  tick(): void;
  /** Run the reconnect that is waiting, as its backoff elapsing would. */
  fireRetry(): void;
  clock: { at: number };
  /** The Record Audio button in the top bar (root, in these mounts). */
  record(): HTMLButtonElement;
  /** The options button beside it — the chooser's door on a one-tap doc. */
  options(): HTMLButtonElement;
  /** The one popover panel — the chooser or the menu, whichever is built. */
  pop(): HTMLElement;
  scrim(): HTMLElement;
  startCta(): HTMLButtonElement;
  stopCta(): HTMLButtonElement;
  /** Pick a chooser radio card by its title ("Just me", "Soniox", …). */
  pick(title: string): void;
  /** The whole start gesture: open the chooser, adjust it, press Start. */
  pressStart(o?: { pick?: string }): void;
  /** The whole stop gesture: open the menu, press Stop Recording. */
  pressStop(): void;
  elapsed(): string;
  caption(): string;
  note(): string;
  /** The speaker tags on the caption, in turn order. */
  tags(): string[];
  /** The rename rows in whichever popover is open. */
  popNames(): string[];
  renameButtons(): HTMLButtonElement[];
}

/** What the strip hands the capture: the frames sink plus the room's facts. */
type CaptureCall = {
  onFrame: (pcm: Int16Array) => void;
  mode: CaptureMode;
  room?: RoomAudioProcessing;
  /** Which stream this call opens — a Mac Audio press makes two of them. */
  source?: MeetingAudioSource;
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.replaceChildren();
});

function mount(
  capture?: (opts: CaptureCall) => Promise<MeetingCaptureStart>,
  extra: {
    autoStart?: boolean;
    autoChoose?: boolean;
    alone?: () => boolean;
    promptName?: (current: string) => string | null;
    mode?: CaptureMode;
    speakers?: number;
    room?: RoomAudioProcessing;
    engine?: 'assemblyai' | 'soniox';
    listEngines?: () => Promise<{ engines: string[]; default: string | null } | null>;
    loadSpeakers?: () => Promise<DocSpeakers | null>;
    onMeetingChange?: (meetingId: string | null) => void;
    onMeetingEnded?: (meetingId: string) => void;
    loadTranscript?: () => Promise<{ lines: string[] } | null>;
    postName?: (meetingId: string, speaker: string, name: string) => Promise<boolean>;
    bot?: MeetingBotClient;
    botNamePrefill?: string;
    offeredNotesMethods?: readonly NotesMethod[];
    dock?: HTMLElement | null;
    systemAudioOffered?: () => boolean;
  } = {},
): Harness {
  const root = document.createElement('div');
  document.body.append(root);
  const sockets: FakeSocket[] = [];
  const clock = { at: 1_000 };
  /** Retries the reconnect scheduled, newest last; `fireRetry` runs one. */
  const retries: Array<() => void> = [];
  let ticker: (() => void) | null = null;
  const stop = vi.fn();
  const strip = mountMeetingStrip({
    docId: 'doc-1',
    root,
    now: () => clock.at,
    interval: (fn) => {
      ticker = fn;
      return () => {
        ticker = null;
      };
    },
    schedule: (fn) => {
      retries.push(fn);
      return () => {
        const at = retries.indexOf(fn);
        if (at >= 0) retries.splice(at, 1);
      };
    },
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    startCapture:
      capture ??
      (() =>
        Promise.resolve({
          ok: true,
          capture: {
            stop,
            setEchoCancellation: () => Promise.resolve(),
            reopen: () => Promise.resolve({ ok: true as const }),
          },
        })),
    ...extra,
  });
  cleanups.push(() => strip.destroy());
  const q = (sel: string) => root.querySelector(sel)?.textContent ?? '';
  const record = () => root.querySelector('.meeting-record') as HTMLButtonElement;
  const pop = () => root.querySelector('.meeting-pop') as HTMLElement;
  const pick = (title: string): void => {
    const card = [...pop().querySelectorAll('.meeting-choice')].find(
      (el) => el.querySelector('.meeting-choice-title')?.textContent === title,
    );
    const input = card?.querySelector('input');
    if (!input) throw new Error(`no chooser card titled "${title}"`);
    input.checked = true;
    input.dispatchEvent(new Event('change'));
  };
  const startCta = () => root.querySelector('.meeting-start-cta') as HTMLButtonElement;
  const stopCta = () => root.querySelector('.meeting-stop-cta') as HTMLButtonElement;
  return {
    root,
    strip,
    sockets,
    clock,
    tick: () => ticker?.(),
    fireRetry: () => {
      const next = retries.shift();
      if (!next) throw new Error('no reconnect was scheduled');
      next();
    },
    record,
    options: () => root.querySelector('.meeting-record-options') as HTMLButtonElement,
    pop,
    scrim: () => root.querySelector('.meeting-scrim') as HTMLElement,
    startCta,
    stopCta,
    pick,
    pressStart: (o = {}) => {
      record().click();
      if (o.pick) pick(o.pick);
      startCta().click();
    },
    pressStop: () => {
      record().click();
      stopCta().click();
    },
    elapsed: () => q('.meeting-elapsed'),
    caption: () => q('.meeting-caption-line'),
    note: () => q('.meeting-note'),
    tags: () => [...root.querySelectorAll('.meeting-speaker')].map((el) => el.textContent ?? ''),
    popNames: () =>
      [...pop().querySelectorAll('.meeting-pop-speaker-name')].map((el) => el.textContent ?? ''),
    renameButtons: () => [...pop().querySelectorAll<HTMLButtonElement>('.meeting-pop-rename')],
  };
}

/** A live capture, for the tests that only care that one exists. */
const fakeCapture = (stop: () => void = vi.fn()) => ({
  stop,
  setEchoCancellation: () => Promise.resolve(),
  reopen: () => Promise.resolve({ ok: true as const }),
});

/** Let the click's promise chain settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('the chrome at rest', () => {
  it('is a Record Audio button and no strip — the row is only paid for live', () => {
    const h = mount();
    expect(h.root.dataset.state).toBe('idle');
    // The strip's grid track is `auto`, so hidden means the editor gets the
    // row back; an idle meeting surface has nothing to say.
    expect(h.root.hidden).toBe(true);
    expect(h.record().textContent).toContain('Record Audio');
    expect(h.record().getAttribute('aria-label')).toBe('Record audio');
    expect(h.record().getAttribute('aria-haspopup')).toBe('menu');
    expect(h.record().classList.contains('is-live')).toBe(false);
    // The glyph shows at rest; the solid red dot is the recording face.
    expect(h.record().querySelector<HTMLElement>('.meeting-record-glyph')?.hidden).toBe(false);
    expect(h.record().querySelector<HTMLElement>('.meeting-record-dot')?.hidden).toBe(true);
  });

  it('docks the button in the bar it was given, and takes it along on destroy', () => {
    const bar = document.createElement('div');
    document.body.append(bar);
    const h = mount(undefined, { dock: bar });
    const btn = bar.querySelector('.meeting-record');
    expect(btn).not.toBeNull();
    expect(h.root.querySelector('.meeting-record')).toBeNull();
    expect(bar.querySelector('.meeting-record-options')).not.toBeNull();
    // Record and its chevron are one box, so the bar sizes them together.
    expect(btn?.parentElement?.className).toBe('meeting-record-dock');
    expect(bar.querySelector('.meeting-record-options')?.parentElement).toBe(btn?.parentElement);
    h.strip.destroy();
    expect(bar.querySelector('.meeting-record')).toBeNull();
    expect(bar.querySelector('.meeting-record-options')).toBeNull();
    expect(bar.querySelector('.meeting-record-dock')).toBeNull();
  });

  it('destroy takes the scrim and popover with it, not just the button', () => {
    // The scrim and both popovers dock beside the button in the TOP BAR, not
    // in `root` (root is `hidden` while idle — see the chooser-was-
    // unreachable-while-idle fix). A destroy that only removed the button
    // left them behind: a SPA navigation to the next doc re-mounts a fresh
    // strip, but the ORPHANED scrim from the last one still sits over the
    // new Record button, and the orphaned popover's own Escape listener is
    // gone (it was removed from `document`, not from the element), so nothing
    // closes it.
    const bar = document.createElement('div');
    document.body.append(bar);
    const h = mount(undefined, { dock: bar });
    bar.querySelector<HTMLButtonElement>('.meeting-record')?.click();
    expect(bar.querySelector<HTMLElement>('.meeting-pop')?.hidden).toBe(false);
    h.strip.destroy();
    expect(bar.querySelector('.meeting-record')).toBeNull();
    expect(bar.querySelector('.meeting-scrim')).toBeNull();
    expect(bar.querySelector('.meeting-pop')).toBeNull();
  });

  it('a press opens the start chooser; the scrim and Escape both close it', () => {
    const h = mount();
    expect(h.pop().hidden).toBe(true);
    h.record().click();
    expect(h.pop().hidden).toBe(false);
    expect(h.scrim().hidden).toBe(false);
    expect(h.record().classList.contains('is-open')).toBe(true);
    expect(h.record().getAttribute('aria-expanded')).toBe('true');
    expect(h.pop().querySelector('.meeting-sheet-title')?.textContent).toBe('Start recording');
    h.scrim().click();
    expect(h.pop().hidden).toBe(true);
    expect(h.record().getAttribute('aria-expanded')).toBe('false');
    h.record().click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.pop().hidden).toBe(true);
  });
});

describe('the start chooser decides who it is listening for', () => {
  const startFrame = (h: Harness) => JSON.parse(String(h.sockets[0]?.sent[0]));

  it('preselects Multiple Speakers — this product’s ordinary meeting has a room', async () => {
    const h = mount();
    h.record().click();
    const selected = h.pop().querySelector('.meeting-choice.is-selected .meeting-choice-title');
    expect(selected?.textContent).toBe('Use microphone');
    const speakerCards = [...h.pop().querySelectorAll('input[name="meeting-speakers"]')];
    expect(speakerCards.map((el) => (el as HTMLInputElement).checked)).toEqual([false, true]);
    h.startCta().click();
    await settle();
    h.sockets[0]?.onopen?.();
    expect(startFrame(h).mode).toBe('conversation');
    expect(h.strip.mode()).toBe('conversation');
  });

  it('Just me is the deliberate cheaper pick, and the frame says so', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    expect(startFrame(h)).toEqual({
      type: 'start',
      sampleRate: MEETING_SAMPLE_RATE,
      encoding: MEETING_AUDIO_ENCODING,
      mode: 'solo',
    });
    expect(h.strip.mode()).toBe('solo');
  });

  it('offers the Mac’s audio only where the browser has a picker, and never preselects it', () => {
    const none = mount(undefined, { systemAudioOffered: () => false });
    none.record().click();
    expect(none.pop().querySelector('.meeting-choice-system')).toBeNull();
    none.strip.destroy();
    const some = mount(undefined, { systemAudioOffered: () => true });
    some.record().click();
    expect(some.pop().querySelector('.meeting-choice-system')).not.toBeNull();
    const selected = some.pop().querySelector('.meeting-choice.is-selected .meeting-choice-title');
    expect(selected?.textContent).toBe('Use microphone');
  });

  it('a press on Mac Audio opens BOTH streams and tells the server so', async () => {
    const capture = vi.fn((_o: CaptureCall) =>
      Promise.resolve({ ok: true as const, capture: fakeCapture() }),
    );
    const h = mount(capture, { systemAudioOffered: () => true });
    h.pressStart({ pick: 'Mac Audio' });
    await settle();
    // Mac Audio MEANS the microphone as well — the Mac-audio-only card it
    // replaced heard the far end of a call and nobody in the room.
    expect(capture.mock.calls.map((c) => c[0]?.source)).toEqual(['mic', 'system']);
    h.sockets[0]?.onopen?.();
    expect(startFrame(h).source).toBe('mic+system');
    // The microphone press above is the control: its frame carries no
    // `source` key, so an older server reads exactly what it always did.
  });

  it('runs on what was granted and says which stream is missing', async () => {
    const capture = vi.fn((o: CaptureCall) =>
      Promise.resolve(
        o.source === 'system'
          ? { ok: false as const, kind: 'denied' as const, message: 'Chrome shared no sound.' }
          : { ok: true as const, capture: fakeCapture() },
      ),
    );
    const h = mount(capture, { systemAudioOffered: () => true });
    h.pressStart({ pick: 'Mac Audio' });
    await settle();
    h.sockets[0]?.onopen?.();
    // The frame names the one stream that opened, so the record cannot claim
    // a meeting it never heard.
    expect(startFrame(h).source).toBeUndefined();
    expect(h.strip.state().kind).toBe('requesting');
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm-partial',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    expect(h.caption()).toContain('Chrome shared no sound.');
    expect(h.caption()).toContain('microphone');
  });

  it('blocks only when BOTH streams were refused, and gives both reasons', async () => {
    const capture = vi.fn((o: CaptureCall) =>
      Promise.resolve({
        ok: false as const,
        kind: 'denied' as const,
        message: `${o.source} refused.`,
      }),
    );
    const h = mount(capture, { systemAudioOffered: () => true });
    h.pressStart({ pick: 'Mac Audio' });
    await settle();
    expect(h.strip.state().kind).toBe('blocked');
    expect(h.caption()).toContain('mic refused.');
    expect(h.caption()).toContain('system refused.');
  });

  it('tells the person headphones stop the remote side being heard twice', async () => {
    const capture = vi.fn((_o: CaptureCall) =>
      Promise.resolve({ ok: true as const, capture: fakeCapture() }),
    );
    const h = mount(capture, { systemAudioOffered: () => true });
    h.pressStart({ pick: 'Mac Audio' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm-echo',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    expect(h.caption()).toContain('Headphones');
  });

  it('an address that says solo presets the chooser the other way', async () => {
    // The Board's solo huddle carries its mode in on the address; the chooser
    // opens agreeing with it rather than arguing.
    const h = mount(undefined, { mode: 'solo' });
    h.record().click();
    const soloInput = [...h.pop().querySelectorAll('input[name="meeting-speakers"]')][0];
    expect((soloInput as HTMLInputElement).checked).toBe(true);
    h.startCta().click();
    await settle();
    h.sockets[0]?.onopen?.();
    expect(startFrame(h).mode).toBe('solo');
  });

  it('adopts what the SERVER says it opened, not what was asked for', async () => {
    const h = mount();
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    // A server that opened a solo session — an older build, or one that
    // refused the surcharge — is the one being billed, and the strip must
    // report the meeting that exists.
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'solo',
    });
    expect(h.strip.mode()).toBe('solo');
  });

  it('keeps the choice across a stop and start — the room did not change', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'solo',
    });
    h.pressStop();
    expect(h.root.dataset.state).toBe('idle');
    h.pressStart();
    await settle();
    h.sockets[1]?.onopen?.();
    expect(JSON.parse(String(h.sockets[1]?.sent[0])).mode).toBe('solo');
  });

  it('offers no knob mid-meeting, because the session cannot be moved', async () => {
    // A streaming session's configuration IS its connect URL, so a switch
    // mid-meeting would mean a second session and a second bill. The menu
    // holds the facts and Stop — no choice cards at all.
    const h = mount();
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    h.record().click();
    expect(h.pop().querySelectorAll('.meeting-choice')).toHaveLength(0);
    expect(h.pop().querySelector('.meeting-start-cta')).toBeNull();
    expect(h.stopCta().textContent).toBe('■ Stop Recording');
  });
});

describe('the strip while a meeting runs', () => {
  it('asks for the mic, opens the doc socket, and announces the format it will send', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    expect(h.root.dataset.state).toBe('requesting');
    expect(h.root.hidden).toBe(false);
    expect(h.note()).toMatch(/asking for the microphone/i);
    await settle();
    const sock = h.sockets[0];
    expect(sock).toBeDefined();
    sock?.onopen?.();
    expect(JSON.parse(String(sock?.sent[0]))).toEqual({
      type: 'start',
      sampleRate: MEETING_SAMPLE_RATE,
      encoding: MEETING_AUDIO_ENCODING,
      mode: 'solo',
    });
  });

  it('goes live on ready: red dot and Recording on the button, a clock off the injected time', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    expect(h.root.dataset.state).toBe('recording');
    expect(h.root.classList.contains('is-live')).toBe(true);
    expect(h.record().classList.contains('is-live')).toBe(true);
    expect(h.record().textContent).toContain('Recording');
    expect(h.record().querySelector<HTMLElement>('.meeting-record-dot')?.hidden).toBe(false);
    expect(h.record().querySelector<HTMLElement>('.meeting-record-glyph')?.hidden).toBe(true);
    h.clock.at = 1_000 + 65_000;
    h.tick();
    expect(h.elapsed()).toBe('01:05');
  });

  it('renders words as they arrive and rewrites a corrected word in place', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 1,
      text: 'come back by thirsty',
      final: false,
    });
    expect(h.caption().trim()).toBe('come back by thirsty');
    const before = h.root.querySelectorAll('.meeting-caption-line .w');
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 1,
      text: 'come back by Thursday',
      final: true,
    });
    const after = h.root.querySelectorAll('.meeting-caption-line .w');
    expect(h.caption().trim()).toBe('come back by Thursday');
    // The same span is rewritten, so the correction animates on the word that
    // was already on screen rather than redrawing the line.
    expect(after[3]).toBe(before[3]);
    expect(after[3]?.classList.contains('is-fixed')).toBe(true);
    expect(after[0]?.classList.contains('is-fixed')).toBe(false);
  });

  it('never writes the transcript into the document body', async () => {
    const editor = document.createElement('div');
    editor.id = 'editor';
    document.body.append(editor);
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'into the strip only', final: true });
    expect(editor.textContent).toBe('');
  });

  it('Stop Recording in the menu tells the server, releases the mic, closes the socket', async () => {
    const stop = vi.fn();
    const h = mount(() => Promise.resolve({ ok: true, capture: fakeCapture(stop) }));
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.pressStop();
    expect(JSON.parse(String(h.sockets[0]?.sent[1]))).toEqual({ type: 'stop' });
    expect(stop).toHaveBeenCalled();
    expect(h.sockets[0]?.closed).toBe(1);
    expect(h.root.dataset.state).toBe('idle');
    // Stop closed the menu too; nothing hangs over an idle surface.
    expect(h.pop().hidden).toBe(true);
  });
});

describe('the speaker menu states the facts settled at start', () => {
  it('headline: Recording · microphone · N speakers · clock, kept in step', async () => {
    const h = mount();
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'Hey.', final: true, speaker: 'B' });
    h.clock.at = 1_000 + 65_000;
    h.record().click();
    const headline = () => h.pop().querySelector('.meeting-pop-headline')?.textContent;
    expect(headline()).toBe('Recording · microphone · 2 speakers · 01:05');
    // A menu left open keeps pace with the clock it quotes.
    h.clock.at += 5_000;
    h.tick();
    expect(headline()).toBe('Recording · microphone · 2 speakers · 01:10');
  });

  it('a voice arriving while the menu is open lands as a row at once', async () => {
    const h = mount();
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    h.record().click();
    expect(h.popNames()).toEqual([]);
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    expect(h.popNames()).toEqual(['Speaker A']);
  });

  it('a menu row renames the voice, everywhere, over the live socket', async () => {
    const h = mount(undefined, { promptName: () => 'Jordan' });
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    h.record().click();
    h.renameButtons()[0]?.click();
    // The row shows only the name once given — never "Speaker A (Jordan)".
    expect(h.popNames()).toEqual(['Jordan']);
    expect(h.tags()).toEqual(['Jordan']);
    const named = (h.sockets[0]?.sent ?? [])
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as { type: string })
      .filter((m) => m.type === 'name_speaker');
    expect(named).toEqual([{ type: 'name_speaker', speaker: 'A', name: 'Jordan' }]);
  });
});

describe('the strip when no words are coming', () => {
  it('says so when transcription is not configured, and the mic goes back', async () => {
    const stop = vi.fn();
    const h = mount(() => Promise.resolve({ ok: true, capture: fakeCapture(stop) }));
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'unavailable',
      reason: 'not_configured',
      message: 'Transcription is not configured on this server.',
    });
    expect(h.root.dataset.state).toBe('unavailable');
    expect(h.root.hidden).toBe(false);
    expect(h.note()).toBe('Transcription is not configured on this server.');
    // …and the mic does not stay open behind a settled state.
    expect(stop).toHaveBeenCalled();
  });

  it('explains an insecure origin rather than failing silently', async () => {
    const h = mount(() =>
      Promise.resolve({
        ok: false,
        kind: 'insecure',
        message: 'Voice needs https or localhost — open http://localhost:8787/review/d1',
      }),
    );
    h.pressStart({ pick: 'Just me' });
    await settle();
    expect(h.root.dataset.state).toBe('blocked');
    expect(h.note()).toContain('http://localhost:8787/review/d1');
    // No socket is opened: there is no meeting to start.
    expect(h.sockets.length).toBe(0);
  });

  it('explains a refused microphone', async () => {
    const h = mount(() =>
      Promise.resolve({
        ok: false,
        kind: 'denied',
        message: 'Microphone permission refused — allow the mic.',
      }),
    );
    h.pressStart({ pick: 'Just me' });
    await settle();
    expect(h.root.dataset.state).toBe('blocked');
    expect(h.note()).toContain('Microphone permission refused');
  });

  it('names a mid-meeting error the server reported', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({ type: 'error', message: 'the engine hung up' });
    expect(h.root.dataset.state).toBe('error');
    expect(h.note()).toBe('the engine hung up');
  });

  it('names a dropped connection only once it has stopped trying to come back', async () => {
    // A drop no longer ends the meeting on its own — the mic stays open and
    // the same meeting id is offered back until the window is spent. The
    // reconnect itself is meeting-reconnect.test.ts; what this one keeps is
    // that the person is still told, in the words they always got, when the
    // meeting really is over.
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.onclose?.();
    expect(h.root.dataset.state).toBe('recording');
    for (let i = 0; i < 40 && h.root.dataset.state === 'recording'; i++) {
      h.fireRetry();
      h.clock.at += 10_000;
      h.sockets[h.sockets.length - 1]?.onclose?.();
    }
    expect(h.root.dataset.state).toBe('error');
    expect(h.note()).toMatch(/connection/i);
  });

  /**
   * Whoever holds a roster for this doc has to be told the moment the doc
   * moves between meetings — otherwise the reassign menu keeps offering the
   * last meeting's voices as targets for a note being written in this one.
   * A start says "a meeting, id unknown"; `ready` names it; a stop leaves the
   * meeting that just ended as the doc's current one.
   */
  it('says which meeting the doc is in, at every boundary', async () => {
    const onMeetingChange = vi.fn();
    const h = mount(undefined, { onMeetingChange });
    h.pressStart({ pick: 'Just me' });
    await settle();
    expect(onMeetingChange.mock.calls.map((c) => c[0])).toEqual([null]);
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm2', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({ type: 'stopped', meetingId: 'm2', endedAt: 2_000 });
    expect(onMeetingChange.mock.calls.map((c) => c[0])).toEqual([null, 'm2', 'm2']);
  });

  /**
   * The tidy-up offer is raised by this callback, so a doc that merely SHOWS
   * an old meeting's cast must never see it fire. Both ways a recording can
   * end have their own case, because each closes the socket — which detaches
   * its handlers — so a meeting only ever travels one of them.
   */
  it('reports the end the server announces, once', async () => {
    const onMeetingEnded = vi.fn();
    const h = mount(undefined, { onMeetingEnded });
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm2', startedAt: 1_000, engine: 'test' });
    // A live meeting has ended nothing yet.
    expect(onMeetingEnded).not.toHaveBeenCalled();
    h.sockets[0]?.serve({ type: 'stopped', meetingId: 'm2', endedAt: 2_000 });
    expect(onMeetingEnded.mock.calls.map((c) => c[0])).toEqual(['m2']);
  });

  it('reports an end from a press of Stop, which the server frame never follows', async () => {
    const onMeetingEnded = vi.fn();
    const h = mount(undefined, { onMeetingEnded });
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm3', startedAt: 1_000, engine: 'test' });
    // `stop()` detaches the socket's handlers, so the server's `stopped` is
    // never read here: without its own call the offer would never appear on
    // the one path most meetings actually end by.
    h.pressStop();
    expect(onMeetingEnded.mock.calls.map((c) => c[0])).toEqual(['m3']);
  });

  /**
   * A bad end is still an end, and it is the end whose notes most need the
   * pass: a meeting that dropped its connection has a gap in its live notes
   * and a whole transcript on disk that could close it. Each of these paths
   * ends a recording somewhere different in the strip, so each gets its own
   * case rather than one standing for the rest.
   */
  it('offers a tidy-up after a server error, and after an unavailable', async () => {
    for (const frame of [
      { type: 'error', message: 'the engine went away' },
      { type: 'unavailable', reason: 'engine_unavailable', message: 'the engine refused' },
    ]) {
      const onMeetingEnded = vi.fn();
      const h = mount(undefined, { onMeetingEnded });
      h.pressStart({ pick: 'Just me' });
      await settle();
      h.sockets[0]?.onopen?.();
      h.sockets[0]?.serve({ type: 'ready', meetingId: 'm-bad', startedAt: 1_000, engine: 'test' });
      h.sockets[0]?.serve(frame);
      expect(onMeetingEnded.mock.calls.map((c) => c[0])).toEqual(['m-bad']);
    }
  });

  it('offers a tidy-up once the reconnect has given up on a dropped meeting', async () => {
    const onMeetingEnded = vi.fn();
    const h = mount(undefined, { onMeetingEnded });
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm-drop', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.onclose?.();
    // Still trying: the meeting is not over, so there is nothing to offer yet.
    expect(h.root.dataset.state).toBe('recording');
    expect(onMeetingEnded).not.toHaveBeenCalled();
    for (let i = 0; i < 40 && h.root.dataset.state === 'recording'; i++) {
      h.fireRetry();
      h.clock.at += 10_000;
      h.sockets[h.sockets.length - 1]?.onclose?.();
    }
    expect(h.root.dataset.state).toBe('error');
    expect(onMeetingEnded.mock.calls.map((c) => c[0])).toEqual(['m-drop']);
  });

  it('offers nothing for a start that never became a meeting', async () => {
    // No `ready`, so no meeting id, so no transcript and nothing to tidy —
    // the guard that makes it safe to fire on every bad end.
    const onMeetingEnded = vi.fn();
    const h = mount(undefined, { onMeetingEnded });
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'unavailable', reason: 'not_configured', message: 'no key' });
    expect(h.root.dataset.state).toBe('unavailable');
    expect(onMeetingEnded).not.toHaveBeenCalled();
  });

  it('settles to idle when the server reports the meeting stopped', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({ type: 'stopped', meetingId: 'm1', endedAt: 2_000 });
    expect(h.root.dataset.state).toBe('idle');
    expect(h.root.classList.contains('is-live')).toBe(false);
  });

  /**
   * A recording the SERVER ended for hearing nothing. Nobody pressed
   * anything, so the strip is the only place the reason can appear — and the
   * person it is for is the one who was not watching, which is why the
   * sentence survives into the idle strip instead of going with the meeting.
   */
  it('says why a recording that timed itself out is over, and offers a fresh one', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({
      type: 'stopped',
      meetingId: 'm1',
      endedAt: 2_000,
      reason: 'silence',
    });
    expect(h.root.dataset.state).toBe('idle');
    expect(h.note()).toBe(MEETING_SILENCE_NOTE);
    // The button is back to its idle face, and the strip is still on screen
    // carrying the sentence.
    expect(h.record().textContent).toContain('Record Audio');
    expect(h.root.hidden).toBe(false);

    // And a tap starts a fresh recording: a new socket, and the sentence about
    // the last one gone.
    h.pressStart({ pick: 'Just me' });
    await settle();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]?.onopen?.();
    h.sockets[1]?.serve({ type: 'ready', meetingId: 'm2', startedAt: 9_000, engine: 'test' });
    expect(h.root.dataset.state).toBe('recording');

    // And the sentence belonged to the meeting that timed out, not to the
    // doc: this one was stopped by a person, so its end says nothing.
    h.sockets[1]?.serve({ type: 'stopped', meetingId: 'm2', endedAt: 10_000 });
    expect(h.note()).toBe('');
    expect(h.root.hidden).toBe(true);
  });

  /**
   * The tidy-up card offers to re-read what a meeting wrote. A recording that
   * timed out having heard nothing wrote nothing, so the card would ask about
   * an empty transcript — on the one ending nobody asked for.
   */
  it('offers no tidy-up for a timeout with no words, and still offers one after speech', async () => {
    const onMeetingEnded = vi.fn();
    const h = mount(undefined, { onMeetingEnded });
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({ type: 'stopped', meetingId: 'm1', endedAt: 2_000, reason: 'silence' });
    expect(onMeetingEnded).not.toHaveBeenCalled();

    // A timeout after somebody spoke is an ordinary end: there is a
    // transcript, and the offer is worth making.
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[1]?.onopen?.();
    h.sockets[1]?.serve({ type: 'ready', meetingId: 'm2', startedAt: 3_000, engine: 'test' });
    h.sockets[1]?.serve({ type: 'transcript', turn: 0, text: 'the levee holds', final: true });
    h.sockets[1]?.serve({ type: 'stopped', meetingId: 'm2', endedAt: 9_000, reason: 'silence' });
    expect(onMeetingEnded).toHaveBeenCalledWith('m2');
  });

  it('says nothing extra when a person stopped the recording', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({ type: 'stopped', meetingId: 'm1', endedAt: 2_000 });
    expect(h.note()).toBe('');
    expect(h.root.hidden).toBe(true);
  });
});

describe('the strip opened by the Board’s huddle button', () => {
  // The button's click is the person's gesture, and a full navigation does not
  // carry it into the editor — so the editor is TOLD, and starts at once.
  it('starts the meeting on mount without a press when asked to', async () => {
    const capture = vi.fn(() => Promise.resolve({ ok: true as const, capture: fakeCapture() }));
    const h = mount(capture, { autoStart: true });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(h.root.dataset.state).toBe('requesting');
    await settle();
    expect(h.sockets).toHaveLength(1);
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    expect(h.root.dataset.state).toBe('recording');
    expect(h.record().textContent).toContain('Recording');
  });

  /**
   * The Board has two entry buttons and they are not the same gesture.
   * "Make a plan" is one person thinking out loud, so it opens the mic on
   * arrival — the press already happened, on a page that is gone. "Have a
   * discussion" has other people in it, and the sentence that tells them
   * they are being recorded is now a button somebody has to press, so it
   * arrives at the CHOICE instead.
   */
  describe('a discussion arrives at the chooser, not at the microphone', () => {
    it('opens the chooser and touches no microphone', () => {
      const capture = vi.fn(() => Promise.resolve({ ok: true as const, capture: fakeCapture() }));
      const h = mount(capture, { autoChoose: true, mode: 'conversation' });
      expect(capture).not.toHaveBeenCalled();
      expect(h.root.dataset.state).toBe('idle');
      expect(h.pop().hidden).toBe(false);
      expect(h.pop().getAttribute('aria-label')).toBe('Start recording');
      // One verb, and the same one whichever mode is selected: the room's
      // announcement and its decline button are gone.
      expect(h.startCta().textContent).toBe('● Start Recording');
      // ONE VERB — a fold's head is a disclosure, not a verb, so it is
      // excluded by class rather than by counting a different number.
      expect(
        [...h.pop().querySelectorAll('button')].filter(
          (b) => !b.classList.contains('meeting-adv-head'),
        ),
      ).toHaveLength(1);
    });

    it('preselects Multiple Speakers, so the choice made on the Board carries', () => {
      const h = mount(undefined, { autoChoose: true, mode: 'conversation' });
      const selected = [...h.pop().querySelectorAll('.meeting-choice')]
        .filter((el) => el.querySelector('input')?.checked === true)
        .map((el) => el.querySelector('.meeting-choice-title')?.textContent);
      expect(selected).toContain('Multiple Speakers');
    });

    it('an open microphone outranks it — a chooser over a live capture decides nothing', async () => {
      const capture = vi.fn(() => Promise.resolve({ ok: true as const, capture: fakeCapture() }));
      const h = mount(capture, { autoStart: true, autoChoose: true, mode: 'conversation' });
      expect(capture).toHaveBeenCalledTimes(1);
      await settle();
      expect(h.pop().hidden).toBe(true);
    });

    it('is not the plan entry — that one still opens the mic', () => {
      // Positive control for the assertion above it: the same mount with the
      // other flag really does reach the microphone, so "not called" is a
      // fact about the flag rather than about the fixture.
      const capture = vi.fn(() => Promise.resolve({ ok: true as const, capture: fakeCapture() }));
      mount(capture, { autoStart: true, mode: 'solo' });
      expect(capture).toHaveBeenCalledTimes(1);
    });
  });

  it('stays at rest when not asked — a plain doc never opens a mic on its own', () => {
    const capture = vi.fn(() => Promise.resolve({ ok: true as const, capture: fakeCapture() }));
    const h = mount(capture);
    expect(capture).not.toHaveBeenCalled();
    expect(h.root.dataset.state).toBe('idle');
  });

  it('offers ONE tap in the strip when the browser wants a gesture, and that tap starts it', async () => {
    // Safari refuses getUserMedia with no user activation and names it the
    // same way it names a real denial. The strip cannot tell them apart, so
    // it asks for the tap rather than reporting a refusal nobody made.
    let refuse = true;
    const capture = vi.fn(() =>
      refuse
        ? Promise.resolve({
            ok: false as const,
            kind: 'denied' as const,
            message: 'Microphone permission refused — allow the mic.',
          })
        : Promise.resolve({ ok: true as const, capture: fakeCapture() }),
    );
    const h = mount(capture, { autoStart: true });
    await settle();
    expect(h.root.dataset.state).toBe('blocked');
    const tap = h.root.querySelector('.meeting-note-start') as HTMLButtonElement;
    expect(tap?.tagName).toBe('BUTTON');
    expect(h.note()).toMatch(/tap/i);
    expect(h.note()).not.toMatch(/refused/i);

    refuse = false;
    tap.click();
    expect(capture).toHaveBeenCalledTimes(2);
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    expect(h.root.dataset.state).toBe('recording');
  });

  it('reports a refusal honestly once the tap itself is refused', async () => {
    const capture = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        kind: 'denied' as const,
        message: 'Microphone permission refused — allow the mic.',
      }),
    );
    const h = mount(capture, { autoStart: true });
    await settle();
    const tap = h.root.querySelector('.meeting-note-start') as HTMLButtonElement;
    expect(tap).not.toBeNull(); // presence
    tap.click();
    await settle();
    // A press IS a gesture, so a refusal now is a real one.
    expect(h.note()).toContain('Microphone permission refused');
    expect(h.root.querySelector('.meeting-note-start')).toBeNull();
  });

  it('does not offer a tap for an origin that gives no mic at all', async () => {
    const h = mount(
      () =>
        Promise.resolve({
          ok: false,
          kind: 'insecure',
          message: 'Voice needs https or localhost — open http://localhost:8787/review/d1',
        }),
      { autoStart: true },
    );
    await settle();
    expect(h.root.dataset.state).toBe('blocked');
    // A tap would not help; the explanation is the whole answer.
    expect(h.root.querySelector('.meeting-note-start')).toBeNull();
    expect(h.note()).toContain('http://localhost:8787/review/d1');
  });
});

describe('the strip across stop and start', () => {
  it('a second meeting starts clean: fresh clock, fresh socket, no words from the last one', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    const first = h.sockets[0];
    expect(first).toBeDefined();
    first?.onopen?.();
    first?.serve({ type: 'ready', meetingId: 'm-1', startedAt: 0, engine: 'mock' });
    first?.serve({ type: 'transcript', turn: 0, text: 'old words', final: true });
    h.clock.at += 65_000;
    h.tick();
    expect(h.elapsed()).toBe('01:05');
    expect(h.caption()).toContain('old words');

    // Stop: the chrome settles to rest — hidden strip, idle button, zeroed
    // clock — and the socket is closed, not abandoned.
    h.pressStop();
    expect(h.root.dataset.state).toBe('idle');
    expect(h.root.hidden).toBe(true);
    expect(h.record().textContent).toContain('Record Audio');
    expect(h.elapsed()).toBe('00:00');
    expect(h.root.classList.contains('is-live')).toBe(false);
    expect(first?.closed).toBe(1);

    // A long idle gap must not leak into the next meeting's clock.
    h.clock.at += 120_000;
    h.pressStart();
    await settle();
    const second = h.sockets[1];
    expect(second).toBeDefined();
    second?.onopen?.();
    second?.serve({ type: 'ready', meetingId: 'm-2', startedAt: 0, engine: 'mock' });
    expect(h.root.dataset.state).toBe('recording');
    // The clock counts THIS meeting only — not the first one, not the gap.
    expect(h.elapsed()).toBe('00:00');
    h.clock.at += 5_000;
    h.tick();
    expect(h.elapsed()).toBe('00:05');
    // And the first meeting's words are gone from the caption.
    expect(h.caption()).not.toContain('old words');
    second?.serve({ type: 'transcript', turn: 0, text: 'new words', final: false });
    expect(h.caption()).toContain('new words');
    // Nothing was sent on the dead socket; the new meeting opened its own.
    expect(JSON.parse(String(second?.sent[0]))).toMatchObject({ type: 'start' });
  });
});

describe('who is speaking', () => {
  const live = async (promptName?: (current: string) => string | null) => {
    const h = mount(undefined, promptName ? { promptName } : {});
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    return h;
  };

  it('tags each turn with its speaker, from the first word, and follows a relabel', async () => {
    const h = await live();
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 0,
      text: 'can you',
      final: false,
      speaker: 'A',
    });
    expect(h.tags()).toEqual(['Speaker A']);
    // The tag sits before the words, inside the turn, so it wraps with them.
    const turn = h.root.querySelector('.meeting-turn');
    expect(turn?.firstElementChild?.classList.contains('meeting-speaker')).toBe(true);
    expect(h.caption().replace(/\s+/g, ' ').trim()).toBe('Speaker A can you');
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'sure', final: false });
    // A turn the engine has not attributed yet has no tag — not "Speaker ?".
    expect(h.tags()).toEqual(['Speaker A']);
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'Sure.', final: true, speaker: 'B' });
    expect(h.tags()).toEqual(['Speaker A', 'Speaker B']);
    // The engine changed its mind about turn 1: the tag follows, in place.
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'Sure.', final: true, speaker: 'A' });
    expect(h.tags()).toEqual(['Speaker A', 'Speaker A']);
  });

  it('a tap on a tag names that speaker everywhere, once, and tells the server', async () => {
    const asked: string[] = [];
    const h = await live((current) => {
      asked.push(current);
      return '  Jordan ';
    });
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 0,
      text: 'Take it?',
      final: true,
      speaker: 'A',
    });
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'Sure.', final: true, speaker: 'B' });
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 2,
      text: 'Thanks.',
      final: true,
      speaker: 'A',
    });
    const tag = h.root.querySelector('.meeting-speaker') as HTMLButtonElement;
    expect(tag.getAttribute('aria-label')).toBe('Name Speaker A');
    tag.click();
    // THE PROMPT OPENS EMPTY on a voice nobody has named. It used to be
    // seeded with the display name, which is how "Room Speaker C" got saved
    // as somebody's name (Bryan, 2026-09-09).
    expect(asked).toEqual(['']);
    expect(h.tags()).toEqual(['Jordan', 'Speaker B', 'Jordan']);
    // A turn that arrives later with the same label reads as Jordan too —
    // and turn 0 has rolled off the three-turn window by then.
    h.sockets[0]?.serve({ type: 'transcript', turn: 3, text: 'Go.', final: false, speaker: 'A' });
    expect(h.tags()).toEqual(['Speaker B', 'Jordan', 'Jordan']);
    expect(h.tags().length).toBe(TRANSCRIPT_KEEP);
    const named = (h.sockets[0]?.sent ?? [])
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as { type: string })
      .filter((m) => m.type === 'name_speaker');
    expect(named).toEqual([{ type: 'name_speaker', speaker: 'A', name: 'Jordan' }]);
    // The prompt offers the current name next time, so a rename starts from it.
    tag.click();
    expect(asked[1]).toBe('Jordan');
  });

  it('a named two-stream voice reads as the name alone, and reprompts from it', async () => {
    // Bryan, 2026-09-09, on a room-plus-remote meeting: the group suffix is
    // noise once a voice has a name, and seeding the prompt with the display
    // name is what saved "John (Room)" and then rendered "John (Room) (Room)".
    const asked: string[] = [];
    const h = await live((current) => {
      asked.push(current);
      return 'John';
    });
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 0,
      text: 'In the room.',
      final: true,
      speaker: 'room:A',
    });
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 1,
      text: 'On the call.',
      final: true,
      speaker: 'remote:B',
    });
    expect(h.tags()).toEqual(['Room Speaker A', 'Remote Speaker B']);
    const tag = h.root.querySelector('.meeting-speaker') as HTMLButtonElement;
    tag.click();
    expect(asked).toEqual(['']);
    expect(h.tags()).toEqual(['John', 'Remote Speaker B']);
    // And the second rename starts from the bare name, not from "John (Room)".
    tag.click();
    expect(asked[1]).toBe('John');
    const named = (h.sockets[0]?.sent ?? [])
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as { type: string; name?: string })
      .filter((m) => m.type === 'name_speaker');
    expect(named[0]).toEqual({ type: 'name_speaker', speaker: 'room:A', name: 'John' });
  });

  it('clips a name to the limit the server enforces, so the two never diverge', async () => {
    const long = 'Jordan'.repeat(30);
    const h = await live(() => long);
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    (h.root.querySelector('.meeting-speaker') as HTMLButtonElement).click();
    const clipped = clipSpeakerName(long);
    // Past the limit the server drops the frame without answering, so an
    // unclipped name would sit on screen while the record and the notes
    // never heard it.
    expect(h.tags()).toEqual([clipped]);
    const named = (h.sockets[0]?.sent ?? [])
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as { type: string; name?: string })
      .filter((m) => m.type === 'name_speaker');
    expect(named).toEqual([{ type: 'name_speaker', speaker: 'A', name: clipped }]);
    // The positive control on the clip: what it produces is what the server
    // accepts. A clip that still overshot would be no clip at all.
    expect(parseMeetingClientMessage(JSON.stringify(named[0]))).not.toBeNull();
  });

  it('a clipped name SAYS it was clipped, and breaks at a word', () => {
    const title = 'Jordan Ashworth, VP of Platform Engineering, EMEA and APAC regions';
    const clipped = clipSpeakerName(title);
    expect(clipped.length).toBeLessThanOrEqual(MAX_SPEAKER_NAME);
    // Cut mid-word and silent, this read as a typo rather than a truncation.
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped).not.toMatch(/Engi…$/);
    expect(title.startsWith(clipped.slice(0, -1))).toBe(true);
    // A name that fits is returned untouched — no stray ellipsis on "Jordan".
    expect(clipSpeakerName('Jordan')).toBe('Jordan');
    expect(clipSpeakerName('x'.repeat(MAX_SPEAKER_NAME))).toBe('x'.repeat(MAX_SPEAKER_NAME));
    // One long word cannot break at a boundary, and must not clip to nothing.
    const oneWord = clipSpeakerName('x'.repeat(MAX_SPEAKER_NAME + 20));
    expect(oneWord.length).toBe(MAX_SPEAKER_NAME);
    expect(oneWord.endsWith('…')).toBe(true);
  });

  it('a cancelled or blank prompt changes nothing and sends nothing', async () => {
    let answer: string | null = null;
    const h = await live(() => answer);
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    const tag = h.root.querySelector('.meeting-speaker') as HTMLButtonElement;
    tag.click();
    answer = '   ';
    tag.click();
    expect(h.tags()).toEqual(['Speaker A']);
    const sent = (h.sockets[0]?.sent ?? []).filter((d) => typeof d === 'string');
    expect(sent.some((d) => String(d).includes('name_speaker'))).toBe(false);
  });

  it('names belong to one meeting: the next one starts with the labels bare', async () => {
    const h = await live(() => 'Jordan');
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    (h.root.querySelector('.meeting-speaker') as HTMLButtonElement).click();
    expect(h.tags()).toEqual(['Jordan']);
    h.pressStop();
    h.pressStart();
    await settle();
    h.sockets[1]?.onopen?.();
    h.sockets[1]?.serve({ type: 'ready', meetingId: 'm2', startedAt: 1_000, engine: 'test' });
    h.sockets[1]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    expect(h.tags()).toEqual(['Speaker A']);
  });
});

describe('naming a voice after the meeting — the chooser keeps the cast', () => {
  /** A two-voice conversation, recorded and then stopped by the server. */
  const stopped = async (extra: Parameters<typeof mount>[1] = {}) => {
    const h = mount(undefined, extra);
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 0,
      text: 'Take it?',
      final: true,
      speaker: 'A',
    });
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'Sure.', final: true, speaker: 'B' });
    h.sockets[0]?.serve({ type: 'stopped', meetingId: 'm1', endedAt: 2_000 });
    return h;
  };

  it('the chooser lists the last meeting’s voices, each with a Rename', async () => {
    const h = await stopped({ promptName: () => null });
    expect(h.root.dataset.state).toBe('idle');
    // The words are gone with the meeting — and so is the strip's row.
    expect(h.root.hidden).toBe(true);
    h.record().click();
    expect(h.pop().querySelector('.meeting-pop-cast')).not.toBeNull();
    expect(h.popNames()).toEqual(['Speaker A', 'Speaker B']);
    expect(h.renameButtons()).toHaveLength(2);
  });

  it('a rename after stop rides HTTP — the socket is gone', async () => {
    const postName = vi.fn(() => Promise.resolve(true));
    const h = await stopped({ promptName: () => 'Priya', postName });
    h.record().click();
    h.renameButtons()[1]?.click();
    await settle();
    expect(h.popNames()).toEqual(['Speaker A', 'Priya']);
    expect(postName).toHaveBeenCalledWith('m1', 'B', 'Priya');
    // Nothing rode the dead socket.
    const sent = (h.sockets[0]?.sent ?? []).filter((d) => typeof d === 'string');
    expect(sent.some((d) => String(d).includes('name_speaker'))).toBe(false);
  });

  it('a name the server refused does not stay on screen claiming it was saved', async () => {
    const postName = vi.fn(() => Promise.resolve(false));
    const h = await stopped({ promptName: () => 'Priya', postName });
    h.record().click();
    h.renameButtons()[1]?.click();
    await settle();
    expect(h.popNames()).toEqual(['Speaker A', 'Speaker B']);
  });

  it('offers the last meeting’s words behind a fold, fetched at the tap', async () => {
    // THE OTHER RECORD. The notes are in the doc; what the meeting HEARD used
    // to live only in the `-raw-transcript.md` beside the server's data dir,
    // which is nowhere for anyone not on that machine — and a bot meeting
    // leaves nothing else behind on screen at all.
    let asked = 0;
    const h = mount(undefined, {
      loadTranscript: () => {
        asked += 1;
        return Promise.resolve({
          lines: ['[09:12:04Z] Rowan Pike: So the Riverbend sync.', '[09:12:09Z] Ada Vale: Right.'],
        });
      },
    });
    await settle();
    h.record().click();
    const fold = document.querySelector('.meeting-pop-transcript') as HTMLDetailsElement;
    expect(fold).toBeTruthy();
    // READ AT THE TAP, not at mount: the meeting somebody wants the words of
    // is usually the one that has just ended.
    expect(asked).toBe(0);

    fold.open = true;
    fold.dispatchEvent(new Event('toggle'));
    await settle();
    expect(asked).toBe(1);
    expect(
      [...fold.querySelectorAll('.meeting-pop-transcript-line')].map((el) => el.textContent),
    ).toEqual(['[09:12:04Z] Rowan Pike: So the Riverbend sync.', '[09:12:09Z] Ada Vale: Right.']);

    // Folded shut and open again asks nothing more.
    fold.open = false;
    fold.dispatchEvent(new Event('toggle'));
    fold.open = true;
    fold.dispatchEvent(new Event('toggle'));
    await settle();
    expect(asked).toBe(1);
  });

  it('says so when the doc has never held a meeting, and offers nothing without the reader', async () => {
    const empty = mount(undefined, { loadTranscript: () => Promise.resolve(null) });
    await settle();
    empty.record().click();
    const fold = document.querySelector('.meeting-pop-transcript') as HTMLDetailsElement;
    fold.open = true;
    fold.dispatchEvent(new Event('toggle'));
    await settle();
    expect(fold.querySelector('.meeting-pop-transcript-body')?.textContent).toBe(
      'No transcript yet.',
    );

    // CONTROL: a strip mounted without the reader grows no fold at all.
    document.body.replaceChildren();
    const bare = mount();
    await settle();
    bare.record().click();
    expect(document.querySelector('.meeting-pop-transcript')).toBeNull();
  });

  it('a reloaded doc offers its last meeting’s cast, and renames it over HTTP', async () => {
    const postName = vi.fn(() => Promise.resolve(true));
    const h = mount(undefined, {
      promptName: () => 'Priya',
      postName,
      loadSpeakers: () =>
        Promise.resolve({
          meetingId: 'm-9',
          voices: [
            { label: 'A', name: 'Devi', lastSaid: 'Move the gate.' },
            { label: 'B', name: 'Speaker B', lastSaid: 'Sure.' },
          ],
        }),
    });
    await settle();
    h.record().click();
    // The names given live come back; the unnamed voice is still a label.
    expect(h.popNames()).toEqual(['Devi', 'Speaker B']);
    h.renameButtons()[1]?.click();
    await settle();
    expect(h.popNames()).toEqual(['Devi', 'Priya']);
    expect(postName).toHaveBeenCalledWith('m-9', 'B', 'Priya');
  });

  /**
   * The channel the notes' own rename entry uses (speaker-rename ticket,
   * AC3). It asks for no prompt and answers whether the name was kept, which
   * is what lets the menu say so — the strip's own pills are gone by then,
   * along with the strip's row and the live transcript zone.
   */
  it('names a voice without a prompt, over HTTP, once the capture has stopped', async () => {
    const postName = vi.fn(() => Promise.resolve(true));
    const h = await stopped({ postName, promptName: () => null });
    await expect(h.strip.renameSpeaker('B', '  Priya  ')).resolves.toBe(true);
    expect(postName).toHaveBeenCalledWith('m1', 'B', 'Priya');
    // And the strip agrees with the notes: its own cast reads the new name.
    h.record().click();
    expect(h.popNames()).toEqual(['Speaker A', 'Priya']);
  });

  it('answers false when the server refused, and takes the name back off', async () => {
    const postName = vi.fn(() => Promise.resolve(false));
    const h = await stopped({ postName, promptName: () => null });
    await expect(h.strip.renameSpeaker('B', 'Priya')).resolves.toBe(false);
    h.record().click();
    expect(h.popNames()).toEqual(['Speaker A', 'Speaker B']);
  });

  it('answers false when there is no meeting to address, rather than keeping a name nowhere', async () => {
    const h = await stopped({ promptName: () => null });
    await expect(h.strip.renameSpeaker('B', 'Priya')).resolves.toBe(false);
    h.record().click();
    expect(h.popNames()).toEqual(['Speaker A', 'Speaker B']);
  });

  /**
   * The race Codex found: on a FIRST open the strip's record read and the
   * notes' own roster read are two requests for the same record, and the
   * menu's can win. A Rename offered off the menu's answer would then reach a
   * strip with no meeting id yet — and "that name wasn't saved" is a lie
   * about a server that refused nothing.
   *
   * Ordered menu-first here by holding the strip's read open across the
   * rename and releasing it afterwards; nothing waits on a clock.
   */
  it('a rename asked for while the record is still loading waits for it, and saves', async () => {
    const postName = vi.fn(() => Promise.resolve(true));
    let release: (() => void) | undefined;
    const loaded = new Promise<DocSpeakers | null>((resolve) => {
      release = () =>
        resolve({
          meetingId: 'm-9',
          voices: [{ label: 'B', name: 'Speaker B', lastSaid: 'Sure.' }],
        });
    });
    const h = mount(undefined, { postName, loadSpeakers: () => loaded });
    // The menu's own request has already answered; the strip's has not.
    const asked = h.strip.renameSpeaker('B', 'Priya');
    let settled: boolean | undefined;
    void asked.then((v) => {
      settled = v;
    });
    await settle();
    // Nothing refused and nothing posted: the id is not knowable yet.
    expect(settled).toBeUndefined();
    expect(postName).not.toHaveBeenCalled();
    release?.();
    await expect(asked).resolves.toBe(true);
    expect(postName).toHaveBeenCalledWith('m-9', 'B', 'Priya');
    h.record().click();
    expect(h.popNames()).toEqual(['Priya']);
  });

  it('a record that never names a meeting still answers, rather than hanging the rename', async () => {
    const postName = vi.fn(() => Promise.resolve(true));
    const h = mount(undefined, { postName, loadSpeakers: () => Promise.resolve(null) });
    await expect(h.strip.renameSpeaker('B', 'Priya')).resolves.toBe(false);
    expect(postName).not.toHaveBeenCalled();
  });

  it('starting a new capture clears the old cast — labels are per meeting', async () => {
    const h = mount(undefined, {
      loadSpeakers: () =>
        Promise.resolve({
          meetingId: 'm-9',
          voices: [{ label: 'A', name: 'Devi', lastSaid: 'Hi.' }],
        }),
    });
    await settle();
    h.record().click();
    expect(h.popNames()).toEqual(['Devi']);
    h.startCta().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm2', startedAt: 1_000, engine: 'test' });
    h.record().click();
    expect(h.popNames()).toEqual([]);
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    // The new meeting's A is a different person; the old name must not stick.
    expect(h.tags()).toEqual(['Speaker A']);
  });

  it('a doc with no meetings shows no cast block at all', async () => {
    const h = mount(undefined, { loadSpeakers: () => Promise.resolve(null) });
    await settle();
    h.record().click();
    expect(h.pop().querySelector('.meeting-pop-cast')).toBeNull();
  });
});

describe('teardown', () => {
  it('releases the mic, the socket and the Record button when the doc is left', async () => {
    const stop = vi.fn();
    const h = mount(() => Promise.resolve({ ok: true, capture: fakeCapture(stop) }));
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.strip.destroy();
    expect(stop).toHaveBeenCalled();
    expect(h.sockets[0]?.closed).toBe(1);
    // The shell element is reusable by the next mount, and hidden until then;
    // the button this mount docked goes with it.
    expect(h.root.hidden).toBe(true);
    expect(h.root.childElementCount).toBe(0);
    expect(document.querySelector('.meeting-record')).toBeNull();
  });

  it('does not leave a mic running when the mount is torn down mid-request', async () => {
    const stop = vi.fn();
    const prompt: { answer?: (v: MeetingCaptureStart) => void } = {};
    const h = mount(
      () =>
        new Promise<MeetingCaptureStart>((r) => {
          prompt.answer = r;
        }),
    );
    h.pressStart({ pick: 'Just me' });
    h.strip.destroy();
    prompt.answer?.({ ok: true, capture: fakeCapture(stop) });
    await settle();
    expect(stop).toHaveBeenCalled();
    expect(h.sockets.length).toBe(0);
  });
});

describe('the socket address', () => {
  it('is the doc audio path on this host', () => {
    expect(meetingSocketPath('w-1', 'doc-1')).toBe('/workspaces/w-1/docs/doc-1/audio');
  });
});

describe('what the strip tells the microphone and the server about the room', () => {
  /** Mount, press Start, and hand back what the capture and the socket saw. */
  async function press(
    extra: Parameters<typeof mount>[1],
    pick?: string,
  ): Promise<{
    call: CaptureCall | undefined;
    start: Record<string, unknown> | undefined;
  }> {
    const calls: CaptureCall[] = [];
    const h = mount((opts) => {
      calls.push(opts);
      return Promise.resolve({
        ok: true,
        capture: {
          stop: vi.fn(),
          setEchoCancellation: () => Promise.resolve(),
          reopen: () => Promise.resolve({ ok: true as const }),
        },
      });
    }, extra);
    h.pressStart(pick ? { pick } : {});
    await settle();
    h.sockets[0]?.onopen?.();
    const sent = h.sockets[0]?.sent
      .filter((raw): raw is string => typeof raw === 'string')
      .map((raw) => JSON.parse(raw) as Record<string, unknown>);
    return { call: calls[0], start: sent?.find((m) => m.type === 'start') };
  }

  it('hands the capture the mode it is about to record in', async () => {
    expect((await press({ mode: 'conversation' })).call?.mode).toBe('conversation');
    expect((await press({}, 'Just me')).call?.mode).toBe('solo');
  });

  it('passes the room processing through, and passes nothing when nobody set it', async () => {
    const room = { echoCancellation: false, noiseSuppression: false, autoGainControl: true };
    expect((await press({ mode: 'conversation', room })).call?.room).toEqual(room);
    // Absent rather than a copy of the default: the default belongs to
    // `captureConstraints`, and two places holding it is two places to change.
    expect((await press({ mode: 'conversation' })).call).not.toHaveProperty('room');
  });

  it('tells the server how many people are in the room, when it was told', async () => {
    expect((await press({ mode: 'conversation', speakers: 3 })).start?.speakers).toBe(3);
    expect((await press({ mode: 'conversation' })).start).not.toHaveProperty('speakers');
  });

  it('records under the mode the chooser is showing, not the one it was mounted with', async () => {
    // The chooser can change it between meetings; the constraints belong to
    // the press, not to the mount.
    const got = await press({ mode: 'solo' }, 'Multiple Speakers');
    expect(got.call?.mode).toBe('conversation');
  });
});

describe('the engine is not a start-time question', () => {
  const threeEngines = () =>
    Promise.resolve({
      engines: ['assemblyai', 'assemblyai-pro', 'soniox'],
      default: 'assemblyai',
    });

  it('never renders an Engine group, however many engines the server holds', async () => {
    const h = mount(undefined, { listEngines: threeEngines });
    await settle();
    h.record().click();
    const labels = [...h.pop().querySelectorAll('.meeting-choice-group-label')].map(
      (e) => e.textContent,
    );
    expect(labels).toEqual(['Source', 'Speakers']);
    expect(h.pop().querySelector('input[name="meeting-engine"]')).toBeNull();
    const titles = [...h.pop().querySelectorAll('.meeting-choice-title')].map((e) => e.textContent);
    expect(titles).not.toContain('Soniox');
    expect(titles).not.toContain('AssemblyAI');
    expect(titles).not.toContain('AssemblyAI Pro');
  });

  it('starts on the server’s default engine, with nothing picked', async () => {
    const h = mount(undefined, { listEngines: threeEngines, mode: 'solo' });
    await settle();
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    expect(JSON.parse(String(h.sockets[0]?.sent[0])).engine).toBe('assemblyai');
  });

  it('sends no engine at all to a server that never listed one', async () => {
    // An old server has no route; its frame stays byte-for-byte what it was.
    const plain = mount(undefined, { listEngines: () => Promise.resolve(null), mode: 'solo' });
    await settle();
    plain.pressStart();
    await settle();
    plain.sockets[0]?.onopen?.();
    expect(JSON.parse(String(plain.sockets[0]?.sent[0]))).not.toHaveProperty('engine');
  });

  it('honours the address’s engine as the preference — the one place it is chosen', async () => {
    // Listed: the preference rides the frame over the default.
    const listed = mount(undefined, { engine: 'soniox', listEngines: threeEngines, mode: 'solo' });
    await settle();
    listed.pressStart();
    await settle();
    listed.sockets[0]?.onopen?.();
    expect(JSON.parse(String(listed.sockets[0]?.sent[0])).engine).toBe('soniox');
    listed.strip.destroy();
    // Unlisted (no route): the address's own ask stands — the server, not
    // this fetch, is the authority on what it refuses.
    const unlisted = mount(undefined, {
      engine: 'soniox',
      listEngines: () => Promise.resolve(null),
      mode: 'solo',
    });
    await settle();
    unlisted.pressStart();
    await settle();
    unlisted.sockets[0]?.onopen?.();
    expect(JSON.parse(String(unlisted.sockets[0]?.sent[0])).engine).toBe('soniox');
    unlisted.strip.destroy();
    // Named but not held by this server: the default, not a refusal.
    const held = mount(undefined, {
      engine: 'soniox',
      listEngines: () => Promise.resolve({ engines: ['assemblyai'], default: 'assemblyai' }),
      mode: 'solo',
    });
    await settle();
    held.pressStart();
    await settle();
    held.sockets[0]?.onopen?.();
    expect(JSON.parse(String(held.sockets[0]?.sent[0])).engine).toBe('assemblyai');
  });

  it('redraws an already-open chooser once a slow fetch answers, so Advanced Options appear', async () => {
    let resolveList:
      | ((v: { engines: string[]; default: string | null } | null) => void)
      | undefined;
    const h = mount(undefined, {
      listEngines: () =>
        new Promise((r) => {
          resolveList = r;
        }),
    });
    h.record().click();
    // The ENGINE's fold. The Note-taker fold beside it is not the engine's
    // and is there whether or not the list ever answers, so the selector has
    // to say which fold this is about.
    const advHead = () =>
      h.pop().querySelector('.meeting-adv:not(.meeting-notetaker) .meeting-adv-head');
    expect(advHead()).toBeNull();
    resolveList?.({ engines: ['assemblyai', 'soniox'], default: 'assemblyai' });
    await settle();
    expect(advHead()).not.toBeNull();
    // Still no engine row came with it.
    expect(h.pop().querySelector('input[name="meeting-engine"]')).toBeNull();
  });
});

describe('one tap when alone', () => {
  const twoEngines = () =>
    Promise.resolve({ engines: ['soniox', 'assemblyai'], default: 'soniox' });

  it('a Record press on a doc with nobody else on it records at once — solo, no chooser', async () => {
    const calls: CaptureCall[] = [];
    const h = mount(
      (o) => {
        calls.push(o);
        return Promise.resolve({ ok: true, capture: fakeCapture() });
      },
      { alone: () => true, listEngines: twoEngines },
    );
    await settle();
    h.record().click();
    expect(h.pop().hidden).toBe(true);
    expect(h.root.dataset.state).toBe('requesting');
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.mode).toBe('solo');
    h.sockets[0]?.onopen?.();
    const frame = JSON.parse(String(h.sockets[0]?.sent[0]));
    expect(frame.type).toBe('start');
    expect(frame.mode).toBe('solo');
    // The server's default, with no picker in the way.
    expect(frame.engine).toBe('soniox');
    expect(h.strip.mode()).toBe('solo');
  });

  it('with somebody else on the doc the press opens the chooser as before', () => {
    const h = mount(undefined, { alone: () => false });
    h.record().click();
    expect(h.pop().hidden).toBe(false);
    expect(h.pop().getAttribute('aria-label')).toBe('Start recording');
    expect(h.root.dataset.state).toBe('idle');
  });

  it('a mount that cannot say who is here asks, as it always did', () => {
    const h = mount();
    h.record().click();
    expect(h.pop().hidden).toBe(false);
    expect(h.root.dataset.state).toBe('idle');
  });

  it('asks presence at the press, not at mount', async () => {
    let alone = false;
    const h = mount(undefined, { alone: () => alone });
    h.record().click();
    expect(h.pop().hidden).toBe(false);
    h.scrim().click();
    expect(h.pop().hidden).toBe(true);
    alone = true;
    h.record().click();
    expect(h.pop().hidden).toBe(true);
    expect(h.root.dataset.state).toBe('requesting');
  });

  it('the options button beside Record opens the chooser even when alone, and is gone while recording', async () => {
    const h = mount(undefined, { alone: () => true });
    expect(h.options().hidden).toBe(false);
    expect(h.options().getAttribute('aria-label')).toBe('Recording options');
    h.options().click();
    expect(h.pop().hidden).toBe(false);
    expect(h.pop().getAttribute('aria-label')).toBe('Start recording');
    expect(h.root.dataset.state).toBe('idle');
    // The chooser's own verb, with its choices honoured over the one-tap
    // default: this is how a conversation gets asked for on a solo doc.
    h.pick('Multiple Speakers');
    h.startCta().click();
    await settle();
    expect(h.strip.mode()).toBe('conversation');
    expect(h.options().hidden).toBe(true);
    // Record now opens the menu — never a second start.
    h.record().click();
    expect(h.pop().querySelector('.meeting-stop-cta')).not.toBeNull();
    h.pressStop();
    expect(h.options().hidden).toBe(false);
  });

  it('the popover’s verb follows the recording state — Start while idle, Stop while live', async () => {
    // The phone report said the options menu offered Start Recording while a
    // recording was running. It does not, and this is the case that says so
    // in behaviour rather than in a code comment: the chevron is the door to
    // a START and is gone the moment there is nothing to start, and the
    // panel Record opens while live carries one verb, which ENDS the capture
    // rather than merely being spelled differently.
    const stopped = vi.fn();
    const h = mount(() => Promise.resolve({ ok: true as const, capture: fakeCapture(stopped) }), {
      alone: () => true,
    });
    h.options().click();
    expect(h.startCta().textContent).toContain('Start Recording');
    expect(h.pop().querySelector('.meeting-stop-cta')).toBeNull();
    h.startCta().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'solo',
    });
    expect(h.strip.state().kind).toBe('recording');

    // Live: no door to a second start, and the one verb is Stop.
    expect(h.options().hidden).toBe(true);
    h.record().click();
    expect(h.pop().querySelector('.meeting-start-cta')).toBeNull();
    expect(h.stopCta().textContent).toBe('■ Stop Recording');

    // And a tap that reaches the chevron anyway — a keyboard, a screen
    // reader, a stylesheet that stops hiding it — lands on the same menu.
    // It used to open the chooser unconditionally, which put a second
    // "Start Recording" in front of somebody already recording.
    h.scrim().click();
    expect(h.pop().hidden).toBe(true);
    h.options().click();
    expect(h.pop().hidden).toBe(false);
    expect(h.pop().querySelector('.meeting-start-cta')).toBeNull();
    expect(h.stopCta().textContent).toBe('■ Stop Recording');

    // The action, not just the label: pressing it ends the capture.
    h.stopCta().click();
    expect(h.strip.state().kind).toBe('idle');
    expect(stopped).toHaveBeenCalled();

    // …and the start door is back, offering Start again.
    expect(h.options().hidden).toBe(false);
    h.record().click();
    expect(h.startCta().textContent).toContain('Start Recording');
  });

  it('a live bot outranks the tap — Record opens the bot’s menu, not a microphone', async () => {
    const calls: CaptureCall[] = [];
    const bot = new FakeBot();
    bot.set('recording', ['Ann']);
    const h = mount(
      (o) => {
        calls.push(o);
        return Promise.resolve({ ok: true, capture: fakeCapture() });
      },
      { alone: () => true, bot },
    );
    await settle();
    h.record().click();
    expect(calls).toHaveLength(0);
    expect(h.pop().hidden).toBe(false);
    expect(h.pop().querySelector('.meeting-stop-cta')?.textContent).toBe('■ Send the bot home');
  });

  it('a solo recording opens with no consent line — there is nobody to have asked', async () => {
    const h = mount(undefined, { alone: () => true });
    h.record().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'solo',
    });
    await settle();
    expect(h.root.dataset.state).toBe('recording');
    expect(h.root.querySelector('.meeting-consent-note')).toBeNull();
    expect(h.root.querySelectorAll('.meeting-note')).toHaveLength(0);
  });
});

describe('advanced options in the chrome', () => {
  const threeEngines = () =>
    Promise.resolve({
      engines: ['soniox', 'assemblyai', 'assemblyai-pro'],
      default: 'soniox',
    });
  /** The same server with AssemblyAI as its default — the panel with the
   *  most knobs. The engine is the server's default now, never a pick here. */
  const assemblyFirst = () =>
    Promise.resolve({
      engines: ['assemblyai', 'soniox', 'assemblyai-pro'],
      default: 'assemblyai',
    });

  /** Open the chooser, expand Advanced Options. */
  const openAdvanced = (h: Harness): void => {
    h.record().click();
    h.pop().querySelector<HTMLButtonElement>('.meeting-adv-head')?.click();
  };

  /** Type one term into a chips control and commit it with Enter. */
  const addTerm = (h: Harness, key: string, term: string): void => {
    const input = h
      .pop()
      .querySelector<HTMLInputElement>(
        `.meeting-adv-ctl[data-key="${key}"] .meeting-adv-chips input`,
      );
    if (!input) throw new Error(`no chips control for ${key}`);
    input.value = term;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };

  /** Drag one range control to a value and settle the drag. */
  const drag = (h: Harness, key: string, value: string): void => {
    const input = h
      .pop()
      .querySelector<HTMLInputElement>(`.meeting-adv-ctl[data-key="${key}"] input[type="range"]`);
    if (!input) throw new Error(`no range control for ${key}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
  };

  it('says beside the Soniox speaker toggle that its labels have no cap', async () => {
    const h = mount(undefined, { listEngines: threeEngines });
    await settle();
    h.record().click();
    expect(h.pop().querySelector('.meeting-engine-hint')?.textContent).toBe(
      "Soniox labels speakers but doesn't cap how many.",
    );
    // The hint is Soniox-and-conversation only: the cap it explains the
    // absence of belongs to diarization, which the other engines do cap.
    h.strip.destroy();
    const other = mount(undefined, { listEngines: assemblyFirst });
    await settle();
    other.record().click();
    expect(other.pop().querySelector('.meeting-engine-hint')).toBeNull();
  });

  it('starts with the moved knobs on the frame — and just the field when nothing moved', async () => {
    const h = mount(undefined, { listEngines: assemblyFirst, mode: 'solo' });
    await settle();
    openAdvanced(h);
    drag(h, 'vad_threshold', '0.8');
    h.startCta().click();
    await settle();
    h.sockets[0]?.onopen?.();
    expect(JSON.parse(String(h.sockets[0]?.sent[0])).tuning).toEqual({ vad_threshold: 0.8 });
    h.strip.destroy();
    // Untouched: the field still travels (it marks the client as owning the
    // speaker cap), but empty.
    const plain = mount(undefined, { listEngines: threeEngines, mode: 'solo' });
    await settle();
    plain.pressStart();
    await settle();
    plain.sockets[0]?.onopen?.();
    expect(JSON.parse(String(plain.sockets[0]?.sent[0])).tuning).toEqual({});
  });

  it('seeds the cap stepper from the address’s ?speakers, per engine panel', async () => {
    const h = mount(undefined, { listEngines: assemblyFirst, speakers: 3 });
    await settle();
    openAdvanced(h);
    expect(
      h.pop().querySelector('.meeting-adv-ctl[data-key="max_speakers"] .meeting-adv-stepnum')
        ?.textContent,
    ).toBe('3');
  });

  it('tunes the live meeting from the menu and shows the server’s answer', async () => {
    const h = mount(undefined, { listEngines: assemblyFirst, mode: 'solo' });
    await settle();
    h.record().click();
    h.startCta().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'assemblyai' });
    h.record().click();
    h.pop().querySelector<HTMLButtonElement>('.meeting-adv-head')?.click();
    drag(h, 'vad_threshold', '0.8');
    const tune = h.sockets[0]?.sent
      .map((f) => JSON.parse(String(f)) as Record<string, unknown>)
      .find((m) => m.type === 'tune');
    expect(tune?.settings).toEqual({ vad_threshold: 0.8 });
    // The confirmation arrives; the control under the finger now says so.
    h.sockets[0]?.serve({ type: 'tuned', applied: ['vad_threshold'] });
    expect(
      h.pop().querySelector('.meeting-adv-ctl[data-key="vad_threshold"] .meeting-adv-note')
        ?.textContent,
    ).toBe('Applied.');

    // Reset mid-meeting reverts the LIVE session too, not just the panel —
    // a panel claiming defaults over an engine still running the tuned
    // values would be lying. The revert travels as the documented default.
    h.pop().querySelector<HTMLButtonElement>('.meeting-adv-reset')?.click();
    const tunes =
      h.sockets[0]?.sent
        .map((f) => JSON.parse(String(f)) as Record<string, unknown>)
        .filter((m) => m.type === 'tune') ?? [];
    expect(tunes.at(-1)?.settings).toEqual({ vad_threshold: 0.4 });
    // And the panel is open with defaults showing, not collapsed over them.
    expect(h.pop().querySelector('.meeting-adv-body')).not.toBeNull();
    expect(h.pop().querySelector('.meeting-adv-moddot')).toBeNull();
  });

  it('admits the one key a mid-meeting reset cannot revert on the live session', async () => {
    // `keyterms_prompt` IS live-tunable, so it earns no "next recording"
    // note — but an EMPTIED list has no wire form (the server reads `[]` as
    // "no change"). Reset therefore leaves the engine running the terms it
    // was given, and the control has to say so instead of showing an empty
    // box over a live list.
    const h = mount(undefined, { listEngines: assemblyFirst, mode: 'solo' });
    await settle();
    h.record().click();
    h.startCta().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'assemblyai' });
    h.record().click();
    h.pop().querySelector<HTMLButtonElement>('.meeting-adv-head')?.click();

    addTerm(h, 'keyterms_prompt', 'Kubernetes');
    const sentTerms = h.sockets[0]?.sent
      .map((f) => JSON.parse(String(f)) as Record<string, unknown>)
      .find((m) => m.type === 'tune');
    expect(sentTerms?.settings).toEqual({ keyterms_prompt: ['Kubernetes'] });
    // The engine confirms it, which is what makes the divergence real.
    h.sockets[0]?.serve({ type: 'tuned', applied: ['keyterms_prompt'] });

    const framesBefore = h.sockets[0]?.sent.length ?? 0;
    h.pop().querySelector<HTMLButtonElement>('.meeting-adv-reset')?.click();
    // No frame goes out for the emptied list — one would apply nothing and
    // still earn an "Applied." the session has not earned.
    expect(h.sockets[0]?.sent.length).toBe(framesBefore);
    expect(
      h.pop().querySelector('.meeting-adv-ctl[data-key="keyterms_prompt"] .meeting-adv-note')
        ?.textContent,
    ).toBe('Cleared here — this recording keeps the terms it already has.');

    // Typing a term again settles the disagreement: the frame travels and
    // the admission goes away.
    addTerm(h, 'keyterms_prompt', 'Postgres');
    expect(h.sockets[0]?.sent.length).toBe(framesBefore + 1);
    expect(
      h
        .pop()
        .querySelector('.meeting-adv-ctl[data-key="keyterms_prompt"] .meeting-adv-note.is-stale'),
    ).toBeNull();
  });

  it('sends no tune frame for an engine that cannot take one', async () => {
    const h = mount(undefined, { listEngines: threeEngines, mode: 'solo' });
    await settle();
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'soniox' });
    h.record().click();
    h.pop().querySelector<HTMLButtonElement>('.meeting-adv-head')?.click();
    drag(h, 'endpoint_sensitivity', '0.5');
    const frames = h.sockets[0]?.sent.map((f) => JSON.parse(String(f)) as { type?: string }) ?? [];
    expect(frames.some((m) => m.type === 'tune')).toBe(false);
    // The panel already told the person where the change goes.
    expect(
      h.pop().querySelector('.meeting-adv-ctl[data-key="endpoint_sensitivity"] .meeting-adv-note')
        ?.textContent,
    ).toBe('Applies to the next recording.');
  });
});

describe('the meeting bot in the chrome', () => {
  it('offers the bot source only where the server can field one', () => {
    const off = new FakeBot();
    off.isConfigured = false;
    const h = mount(undefined, { bot: off });
    h.record().click();
    expect(h.pop().querySelector('.meeting-choice-bot')).toBeNull();
    h.strip.destroy();
    const on = mount(undefined, {
      bot: new FakeBot(),
      botNamePrefill: "Bryan's Claude Code Agent",
    });
    on.record().click();
    expect(on.pop().querySelector('.meeting-choice-bot')).not.toBeNull();
    const name = on.pop().querySelector('.meeting-bot-name') as HTMLInputElement;
    // The prefilled name is editable, not a placeholder that vanishes.
    expect(name.value).toBe("Bryan's Claude Code Agent");
  });

  it('Start with a link sends the bot, name and all, and closes the sheet', async () => {
    const bot = new FakeBot();
    const h = mount(undefined, { bot, botNamePrefill: "Bryan's Claude Code Agent" });
    h.record().click();
    h.pick('Join Zoom / Google Meet');
    const url = h.pop().querySelector('.meeting-bot-url') as HTMLInputElement;
    url.value = ' https://meet.google.com/abc-defg-hij ';
    url.dispatchEvent(new Event('input'));
    const name = h.pop().querySelector('.meeting-bot-name') as HTMLInputElement;
    name.value = "Priya's Notetaker";
    name.dispatchEvent(new Event('input'));
    h.startCta().click();
    await settle();
    expect(bot.invites).toEqual([
      { url: 'https://meet.google.com/abc-defg-hij', name: "Priya's Notetaker" },
    ]);
    expect(h.pop().hidden).toBe(true);
    // No microphone was opened: the bot is the capture.
    expect(h.sockets).toHaveLength(0);
  });

  it('a refused invite stays in the sheet with the reason', async () => {
    const bot = new FakeBot();
    bot.refuse = 'That is not a Zoom, Google Meet or Teams link.';
    const h = mount(undefined, { bot });
    h.record().click();
    h.pick('Join Zoom / Google Meet');
    h.startCta().click();
    await settle();
    expect(h.pop().hidden).toBe(false);
    expect(h.pop().querySelector('.meeting-pop-error')?.textContent).toBe(
      'That is not a Zoom, Google Meet or Teams link.',
    );
  });

  it('a live bot owns the strip: its state is the line, its progress the light', () => {
    const bot = new FakeBot();
    const h = mount(undefined, { bot });
    expect(h.root.hidden).toBe(true);
    bot.set('waiting_room');
    expect(h.root.hidden).toBe(false);
    expect(h.note()).toBe('Waiting to be let in');
    // Not recording yet: the button must not claim it is.
    expect(h.record().textContent).toContain('Record Audio');
    bot.set('recording', ['Ann', 'Ben']);
    expect(h.root.classList.contains('is-live')).toBe(true);
    expect(h.record().textContent).toContain('Recording');
    expect(h.note()).toBe('Recording · Ann, Ben');
  });

  it('the menu behind a live bot lists who it hears, and sends it home', async () => {
    const bot = new FakeBot();
    const h = mount(undefined, { bot });
    bot.set('recording', ['Ann', 'Ben']);
    h.record().click();
    expect(h.popNames()).toEqual(['Ann', 'Ben']);
    // A bot's speakers are display names from the call — nothing to rename.
    expect(h.renameButtons()).toHaveLength(0);
    expect(h.stopCta().textContent).toBe('■ Send the bot home');
    h.stopCta().click();
    await settle();
    expect(bot.leaves).toBe(1);
    expect(h.pop().hidden).toBe(true);
  });

  it('a terminal state is news only when the bot was seen alive here', () => {
    // Found already-terminal at load it is history, not news.
    const stale = new FakeBot();
    stale.current = botStatus('left');
    const h = mount(undefined, { bot: stale });
    expect(h.root.hidden).toBe(true);
    h.strip.destroy();

    const bot = new FakeBot();
    const h2 = mount(undefined, { bot });
    bot.set('recording', ['Ann']);
    bot.set('left');
    expect(h2.root.hidden).toBe(false);
    expect(h2.note()).toBe('The bot has left');
    // Dismissible: the farewell is a line, not a permanent fixture.
    (h2.root.querySelector('.meeting-note-dismiss') as HTMLButtonElement).click();
    expect(h2.root.hidden).toBe(true);
  });

  it("a live bot's words roll on the line as the microphone's do, under the platform's names", () => {
    const bot = new FakeBot();
    const h = mount(undefined, { bot });
    bot.set('recording', ['Rowan Pike']);
    // Until the first word the line narrates the bot's state…
    expect(h.note()).toBe('Recording · Rowan Pike');
    // …and the first partial replaces that narration with the words.
    bot.speak({ turn: 0, text: 'so the', final: false, speaker: 'p7', speakerName: 'Rowan Pike' });
    expect(h.note()).toBe('');
    expect(h.caption()).toContain('so the');
    expect(h.tags()).toEqual(['Rowan Pike']);
    // A later partial for the SAME turn replaces it in place — the whole
    // correction mechanism, and the thing the microphone strip does.
    bot.speak({
      turn: 0,
      text: 'So the sync is the bottleneck.',
      final: true,
      speaker: 'p7',
      speakerName: 'Rowan Pike',
    });
    expect(h.root.querySelectorAll('.meeting-turn')).toHaveLength(1);
    expect(h.caption()).toContain('So the sync is the bottleneck.');
    expect(h.caption()).not.toContain('so the sync is');
    bot.speak({ turn: 1, text: 'Measure it.', final: true, speaker: 'p8', speakerName: 'Devi' });
    expect(h.tags()).toEqual(['Rowan Pike', 'Devi']);
    expect(h.root.querySelectorAll('.meeting-turn')).toHaveLength(2);
    // The recording face, same as the microphone's.
    expect(h.root.classList.contains('is-live')).toBe(true);
    // The tag is the same pill but not a rename button: a live bot meeting
    // cannot be renamed from the strip, and a tap that could only fail is
    // not offered.
    expect(h.root.querySelectorAll('button.meeting-speaker')).toHaveLength(0);
    expect(h.root.querySelectorAll('.meeting-speaker.is-fixed')).toHaveLength(2);
  });

  it('POSITIVE CONTROL: a microphone frame still renders through the same fold', async () => {
    // Same harness, same accessors — proves `caption()`/`tags()` see a turn
    // the socket path draws, so the bot assertions above are not vacuous.
    const h = mount(undefined, { bot: new FakeBot() });
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    expect(h.caption()).toContain('Hi.');
    expect(h.tags()).toEqual(['Speaker A']);
    // And the microphone's tag IS the rename button.
    expect(h.root.querySelectorAll('button.meeting-speaker')).toHaveLength(1);
  });

  it("a bot's words are dropped while this strip's own microphone is the capture", async () => {
    const bot = new FakeBot();
    const h = mount(undefined, { bot });
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'solo',
    });
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Mine.', final: true });
    bot.speak({ turn: 0, text: 'Not mine.', final: true, speaker: 'p7', speakerName: 'Rowan' });
    expect(h.caption()).toContain('Mine.');
    expect(h.caption()).not.toContain('Not mine.');
  });

  it('a bot leaving clears the window, and the next bot meeting starts from turn 0', () => {
    const bot = new FakeBot();
    const h = mount(undefined, { bot });
    bot.set('recording', ['Rowan Pike']);
    bot.speak({ turn: 0, text: 'First.', final: true, speaker: 'p7', speakerName: 'Rowan Pike' });
    bot.speak({ turn: 1, text: 'Second.', final: true, speaker: 'p7', speakerName: 'Rowan Pike' });
    bot.set('left');
    expect(h.note()).toBe('The bot has left');
    expect(h.root.querySelectorAll('.meeting-turn')).toHaveLength(0);
    // A new bot, a new meeting: its turn 0 must not read as "older than the
    // newest" and be dropped by the rolling window.
    bot.set('recording', ['Devi']);
    bot.speak({ turn: 0, text: 'Again.', final: true, speaker: 'p9', speakerName: 'Devi' });
    expect(h.caption()).toContain('Again.');
    expect(h.caption()).not.toContain('Second.');
    expect(h.tags()).toEqual(['Devi']);
  });
});

/**
 * What replaced the consent step.
 *
 * The step that stood here spoke a fixed sentence into the room's own
 * microphone, offered a second button that declined it, and wrote down which
 * path was taken. Bryan removed all of it on 2026-09-01 — "This is too much
 * fiddling. I'll manually handle consent for now." — and what is left is one
 * line at the head of the transcript.
 *
 * These are mostly NEGATIVE tests, so each one carries the positive control
 * that says the strip is still doing its job: a chooser that renders nothing
 * has no skip button either, and a transcript panel that never draws has no
 * announcement in it.
 */
describe('the consent step is gone', () => {
  it('offers ONE start verb, the same one, whichever room the chooser is set to', () => {
    const h = mount(undefined, { mode: 'conversation' });
    h.record().click();
    expect(h.startCta().textContent).toBe('● Start Recording');
    // The skip verb was the decline path. It is the button whose absence is
    // the removal, so it is asserted by class as well as by count.
    expect(h.pop().querySelector('.meeting-skip-cta')).toBeNull();
    // ONE VERB — a fold's head is a disclosure, not a verb, so it is
    // excluded by class rather than by counting a different number.
    expect(
      [...h.pop().querySelectorAll('button')].filter(
        (b) => !b.classList.contains('meeting-adv-head'),
      ),
    ).toHaveLength(1);
    // Flipping to the solo room used to change both the verb's words and the
    // button count. Now it changes neither.
    h.pick('Just me');
    expect(h.startCta().textContent).toBe('● Start Recording');
    // ONE VERB — a fold's head is a disclosure, not a verb, so it is
    // excluded by class rather than by counting a different number.
    expect(
      [...h.pop().querySelectorAll('button')].filter(
        (b) => !b.classList.contains('meeting-adv-head'),
      ),
    ).toHaveLength(1);
  });

  it('quotes no sentence for the room to hear', () => {
    const h = mount(undefined, { mode: 'conversation' });
    h.record().click();
    expect(h.pop().querySelector('.meeting-announce-quote')).toBeNull();
    expect(h.pop().textContent).not.toMatch(/being recorded and transcribed/i);
    // The positive control: the chooser IS built, so the two assertions above
    // are about missing chrome rather than a missing popover.
    expect(h.pop().textContent).toContain('Multiple Speakers');
  });

  it('says nothing on the wire about how the room was told', async () => {
    const h = mount(undefined, { mode: 'conversation' });
    h.pressStart();
    await settle();
    const sock = h.sockets[0];
    sock?.onopen?.();
    sock?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    await settle();
    const frames = (sock?.sent ?? [])
      .filter((x): x is string => typeof x === 'string')
      .map((x) => JSON.parse(x) as { type: string });
    expect(frames.map((f) => f.type)).not.toContain('announced');
    // Positive control: the socket carried the frame it is supposed to.
    expect(frames.map((f) => f.type)).toContain('start');
    // And the handle no longer reports a consent path at all.
    expect('announced' in h.strip).toBe(false);
  });

  it('does not report the room as told even for a conversation that runs', async () => {
    // The strip used to hold this on `mode === conversation`, which is the
    // one setting that could resurrect it silently.
    const h = mount(undefined, { mode: 'conversation' });
    h.pressStart();
    await settle();
    const sock = h.sockets[0];
    sock?.onopen?.();
    sock?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    await settle();
    expect(h.strip.mode()).toBe('conversation');
    expect(h.root.dataset.state).toBe('recording');
  });
});

describe('the transcript panel opens with the consent reminder', () => {
  /** A conversation capture taken all the way to `recording`. */
  const recording = async (mode: CaptureMode = 'conversation') => {
    const h = mount(undefined, { mode });
    h.pressStart();
    await settle();
    const sock = h.sockets[0];
    sock?.onopen?.();
    sock?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test', mode });
    await settle();
    return { h, sock };
  };

  it('shows the single line, and no more than it', async () => {
    const { h } = await recording();
    expect(h.note()).toBe(RECORDING_CONSENT_NOTE);
    expect(h.root.querySelectorAll('.meeting-note')).toHaveLength(1);
    // It is the fixed line, not a sentence composed here: the words are
    // asserted through the export, and their substance in core's own test.
    expect(h.note()).toMatch(/^By recording/);
  });

  it('is chrome, not a turn — it is not a caption anybody said', async () => {
    const { h } = await recording();
    // The class the stylesheet italicises it by. A note that lost it would
    // read as a transcript line, which is the one thing it must not be.
    expect(h.root.querySelector('.meeting-consent-note')).not.toBeNull();
    expect(h.root.querySelectorAll('.meeting-turn')).toHaveLength(0);
  });

  it('gives the line to the words the moment there are any', async () => {
    const { h, sock } = await recording();
    sock?.serve({
      type: 'transcript',
      turn: 0,
      text: 'So the sync is the bottleneck',
      final: false,
    });
    expect(h.caption()).toContain('So the sync is the bottleneck');
    expect(h.root.querySelector('.meeting-consent-note')).toBeNull();
  });

  it('does not come back over a transcript that has already started', async () => {
    // A settled turn used to be what released the announcement's hold. The
    // reminder has no hold to release, and must not reappear between turns.
    const { h, sock } = await recording();
    sock?.serve({ type: 'transcript', turn: 0, text: 'First.', final: true });
    sock?.serve({ type: 'transcript', turn: 1, text: 'Second.', final: false });
    expect(h.root.querySelector('.meeting-consent-note')).toBeNull();
    expect(h.caption()).toContain('Second.');
  });

  it('is not shown for a solo capture — a reminder with nobody to have asked', async () => {
    // "Just me" says there is no room; a line about asking it is a question
    // with no answer (Urgent-fixes ticket, 2026-09-02).
    const { h } = await recording('solo');
    expect(h.root.querySelector('.meeting-consent-note')).toBeNull();
    expect(h.note()).toBe('');
  });

  it('is not on the strip before a recording starts', async () => {
    // The strip is hidden at rest, so a reminder there would be a line about
    // a recording that is not happening.
    const h = mount(undefined, { mode: 'conversation' });
    expect(h.root.hidden).toBe(true);
    expect(h.root.querySelector('.meeting-consent-note')).toBeNull();
  });

  it('yields to the reason a meeting could not start', async () => {
    // `unavailable` writes its own note through the same line. The reminder
    // must not sit under a meeting that is not recording anything.
    const h = mount(undefined, { mode: 'conversation' });
    h.pressStart();
    await settle();
    const sock = h.sockets[0];
    sock?.onopen?.();
    sock?.serve({
      type: 'unavailable',
      reason: 'not_configured',
      message: 'Transcription is not configured on this server.',
    });
    expect(h.note()).toBe('Transcription is not configured on this server.');
    expect(h.root.querySelector('.meeting-consent-note')).toBeNull();
  });
});

describe('the note-taker answer a running meeting sends back', () => {
  const frame = (raw: Record<string, unknown>) => parseMeetingServerMessage(JSON.stringify(raw));

  it('parses a recorded change', () => {
    expect(frame({ type: 'notes_method', method: 'ledger-opus', recorded: true })).toEqual({
      type: 'notes_method',
      method: 'ledger-opus',
      recorded: true,
    });
  });

  it('a missing `recorded` reads as NOT recorded, never as success', () => {
    // An older server that answers nothing about the write must not be taken
    // for one that wrote: the row would then claim a switch that no tick uses.
    expect(frame({ type: 'notes_method', method: 'ledger-opus' })).toEqual({
      type: 'notes_method',
      method: 'ledger-opus',
      recorded: false,
    });
  });

  it('MUTATION CONTROL: a note-taker this client has no row for is dropped', () => {
    expect(frame({ type: 'notes_method', method: 'ledger-sonnet-9', recorded: true })).toBeNull();
  });
});

/**
 * TWO NOTE-TAKER PICKS OVER ONE LIVE SOCKET, ANSWERED OUT OF STEP.
 *
 * The switch is optimistic — the row moves at the press — and the server
 * answers each write separately. A person who changes their mind before the
 * first answer lands has two writes out at once, and the answers name a
 * method rather than a number. Reading them against whatever the row happens
 * to show let an earlier success confirm the later pick and the later refusal
 * then roll back onto that same pick, leaving the fold claiming a note-taker
 * the server had thrown away — with nothing on screen to say so.
 */
describe('two note-taker picks over a live meeting, answered out of step', () => {
  const offeredNotesMethods: readonly NotesMethod[] = ['original', 'ledger-haiku', 'ledger-opus'];

  /** A recording meeting whose menu holds the note-taker fold, opened. */
  async function liveWithFold(): Promise<Harness> {
    const h = mount(undefined, { offeredNotesMethods });
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    // The Record button over a running meeting opens the MENU, and the fold
    // sits in it collapsed with the current note-taker on its head line.
    h.record().click();
    h.pop().querySelector<HTMLButtonElement>('.meeting-notetaker .meeting-adv-head')?.click();
    return h;
  }

  /** What the fold says it is on: the head line, and the row that is checked. */
  const shows = (h: Harness) => ({
    head: h.pop().querySelector('.meeting-notetaker .meeting-adv-value')?.textContent ?? '',
    checked:
      h.pop().querySelector<HTMLInputElement>('.meeting-notetaker input:checked')?.value ?? '',
  });

  /** Every note-taker this socket was asked to switch to, in order. */
  const asked = (h: Harness): string[] =>
    h.sockets[0]?.sent
      .filter((raw): raw is string => typeof raw === 'string')
      .map((raw) => JSON.parse(raw) as { type: string; method?: string })
      .filter((m) => m.type === 'set_notes_method')
      .map((m) => m.method ?? '') ?? [];

  it('ends on the note-taker the server kept, not on the one it refused', async () => {
    const h = await liveWithFold();
    h.pick('Ledger · Haiku');
    h.pick('Ledger · Opus');
    expect(asked(h)).toEqual(['ledger-haiku', 'ledger-opus']);
    // Both writes are out. The first is kept and the second refused, so the
    // server goes on composing with the FIRST.
    h.sockets[0]?.serve({ type: 'notes_method', method: 'ledger-haiku', recorded: true });
    h.sockets[0]?.serve({ type: 'notes_method', method: 'ledger-opus', recorded: false });
    expect(shows(h)).toEqual({ head: 'Ledger · Haiku', checked: 'ledger-haiku' });
  });

  it('MUTATION CONTROL: with both kept, the row stays on the later pick', async () => {
    const h = await liveWithFold();
    h.pick('Ledger · Haiku');
    h.pick('Ledger · Opus');
    h.sockets[0]?.serve({ type: 'notes_method', method: 'ledger-haiku', recorded: true });
    h.sockets[0]?.serve({ type: 'notes_method', method: 'ledger-opus', recorded: true });
    expect(shows(h)).toEqual({ head: 'Ledger · Opus', checked: 'ledger-opus' });
  });

  it('the earlier answer alone does not settle the row the person is watching', async () => {
    const h = await liveWithFold();
    h.pick('Ledger · Haiku');
    h.pick('Ledger · Opus');
    h.sockets[0]?.serve({ type: 'notes_method', method: 'ledger-haiku', recorded: true });
    // The second write is still out: the person keeps looking at their pick.
    expect(shows(h)).toEqual({ head: 'Ledger · Opus', checked: 'ledger-opus' });
  });

  /**
   * TWO AT-REST WRITES, AND THE ROW MUST END WHERE THE DOC DID.
   *
   * The server applies a `PUT` when it arrives; the browser learns of it when
   * the response comes back, and those are not the same order. So response
   * order cannot be allowed to decide anything — the fold read the LAST
   * answer as the doc's state, and with both writes allowed out at once the
   * last answer could be the EARLIER write, leaving the row on a method the
   * doc had already replaced and every later compose ignoring it.
   *
   * The harness is the shape that broke it: the newest outstanding request
   * answers first. What it asserts is the invariant itself — the row shows
   * the last method this server actually wrote — so it holds whichever way
   * the client chooses to keep its writes in step.
   */
  it('ends on the last method the server wrote, whatever order the answers come back in', async () => {
    /** Every write this server applied, in the order it applied them. */
    const applied: string[] = [];
    /** Requests it has taken but not yet answered. */
    const outstanding: Array<() => void> = [];
    const bot = new FakeBot();
    bot.set('recording', ['Ann']);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: { method?: string; body?: string }) => {
        if (init?.method !== 'PUT') return Promise.resolve(new Response('{}', { status: 404 }));
        const body = JSON.parse(init.body ?? '{}') as { method?: string };
        // Applied on ARRIVAL, which is what makes the last one here the one
        // the doc holds — whenever its answer happens to get back.
        applied.push(body.method ?? '');
        return new Promise<Response>((resolve) => {
          outstanding.push(() => resolve(new Response('{}', { status: 200 })));
        });
      }),
    );
    cleanups.push(() => vi.unstubAllGlobals());
    const h = mount(undefined, { bot, offeredNotesMethods });
    h.record().click();
    h.pop().querySelector<HTMLButtonElement>('.meeting-notetaker .meeting-adv-head')?.click();
    h.pick('Ledger · Haiku');
    h.pick('Ledger · Opus');
    await vi.waitFor(() => expect(outstanding.length).toBeGreaterThan(0));
    // Newest first, until the server has nothing left in hand.
    while (outstanding.length > 0) {
      outstanding.pop()?.();
      await settle();
      await settle();
    }
    expect(applied).toEqual(['ledger-haiku', 'ledger-opus']);
    expect(shows(h).checked).toBe(applied[applied.length - 1]);
  });

  /**
   * THE SOCKET DIES BETWEEN THE FRAME AND ITS ANSWER.
   *
   * The pick was sent and nothing came back, and nothing ever will — that
   * socket is gone. The server either applied the change or never saw it, and
   * the row cannot tell from anything it holds. Left as it was, the fold goes
   * on stating a note-taker with the same confidence it states a confirmed
   * one, which is the exact thing the confirmed/pending split exists to
   * prevent.
   *
   * Every test here asserts the same invariant — the row ends on the method
   * THIS SERVER holds — and drives the two truths a drop can be hiding.
   */
  describe('a note-taker pick whose socket dies before the answer', () => {
    /**
     * The server's own note-taker, as its GET reports it. Only that route
     * answers: everything else the mount asks for is left as unavailable, so
     * this stub decides one thing and the rest of the strip behaves as it
     * does under every other mount here.
     */
    function serveMethod(current: () => string): void {
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: { method?: string }) =>
          Promise.resolve(
            String(url).includes('/notes-method') &&
              (init?.method === undefined || init.method === 'GET')
              ? new Response(JSON.stringify({ method: current() }), { status: 200 })
              : new Response('{}', { status: 404 }),
          ),
        ),
      );
      cleanups.push(() => vi.unstubAllGlobals());
    }

    /** The drop, the backoff, and the meeting coming back on a new socket. */
    async function dropAndReconnect(h: Harness): Promise<void> {
      h.sockets[0]?.onclose?.();
      await settle();
      h.fireRetry();
      await settle();
      h.sockets[1]?.onopen?.();
      h.sockets[1]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
      await settle();
    }

    it('takes the change when the server did apply it', async () => {
      let held = 'original';
      serveMethod(() => held);
      const h = await liveWithFold();
      h.pick('Ledger · Opus');
      // The frame arrived and was applied; the ANSWER is what the drop ate.
      held = 'ledger-opus';
      await dropAndReconnect(h);
      await vi.waitFor(() => expect(shows(h).checked).toBe(held));
      // And the row is SETTLED, not still waiting on a frame nobody will
      // answer: a refusal on the new socket rolls back to what the server
      // holds, which a pick left pending for ever would prevent.
      h.pick('Ledger · Haiku');
      h.sockets[1]?.serve({ type: 'notes_method', method: 'ledger-haiku', recorded: false });
      expect(shows(h).checked).toBe(held);
    });

    it('gives the change back when the server never saw it', async () => {
      let held = 'original';
      serveMethod(() => held);
      const h = await liveWithFold();
      h.pick('Ledger · Opus');
      // The frame died in the socket: the doc is still on what it had.
      held = 'original';
      await dropAndReconnect(h);
      await vi.waitFor(() => expect(shows(h).checked).toBe(held));
    });

    /**
     * A DROP THAT IS NOT A RECONNECT. The socket can go away before the
     * meeting ever says `ready` — the strip gives up on it and says the
     * connection was lost, rather than retrying — and a pick made in that
     * window went over the socket like any other. It is stranded the same
     * way, so it is settled the same way.
     */
    it('settles a pick whose socket died before the meeting opened', async () => {
      const held = 'original';
      serveMethod(() => held);
      const h = mount(undefined, { offeredNotesMethods });
      h.pressStart({ pick: 'Just me' });
      await settle();
      h.sockets[0]?.onopen?.();
      // Open but not yet `ready`: the Record button opens the menu, and the
      // fold in it sends over the socket.
      h.record().click();
      h.pop().querySelector<HTMLButtonElement>('.meeting-notetaker .meeting-adv-head')?.click();
      h.pick('Ledger · Opus');
      // The frame died in the socket, so the doc is still on what it had —
      // the branch where a row left stranded states the wrong note-taker.
      // No `ready` ever came, so this drop is not retried: the strip says the
      // connection was lost and the meeting is over before it began.
      h.sockets[0]?.onclose?.();
      await settle();
      // The person tries again. The meeting that opens has the fold in its
      // menu, reading the same row the lost pick was made on.
      h.startCta().click();
      await settle();
      h.sockets[1]?.onopen?.();
      h.sockets[1]?.serve({ type: 'ready', meetingId: 'm2', startedAt: 2_000, engine: 'test' });
      await settle();
      // The menu, with the fold still open from before the drop.
      h.record().click();
      await vi.waitFor(() => expect(shows(h).checked).toBe(held));
    });
  });

  it('holds the second press until the first write has answered', async () => {
    // The guarantee the row's correctness rests on: with one write out at a
    // time, the order the server applies them is the order they were pressed,
    // so its last write is the last press and the last answer describes it.
    const applied: string[] = [];
    const outstanding: Array<() => void> = [];
    const bot = new FakeBot();
    bot.set('recording', ['Ann']);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: { method?: string; body?: string }) => {
        if (init?.method !== 'PUT') return Promise.resolve(new Response('{}', { status: 404 }));
        applied.push((JSON.parse(init.body ?? '{}') as { method?: string }).method ?? '');
        return new Promise<Response>((resolve) => {
          outstanding.push(() => resolve(new Response('{}', { status: 200 })));
        });
      }),
    );
    cleanups.push(() => vi.unstubAllGlobals());
    const h = mount(undefined, { bot, offeredNotesMethods });
    h.record().click();
    h.pop().querySelector<HTMLButtonElement>('.meeting-notetaker .meeting-adv-head')?.click();
    h.pick('Ledger · Haiku');
    h.pick('Ledger · Opus');
    await vi.waitFor(() => expect(applied).toEqual(['ledger-haiku']));
    await settle();
    // Still just the one: the second press is waiting its turn, not racing.
    expect(applied).toEqual(['ledger-haiku']);
    outstanding.pop()?.();
    await vi.waitFor(() => expect(applied).toEqual(['ledger-haiku', 'ledger-opus']));
  });

  /**
   * A BOT MEETING ASKS OVER HTTP, and a refused write must take its "since"
   * back with it.
   *
   * Nobody in this browser is listening to a bot meeting, so the switch goes
   * on the REST route rather than an audio socket — but it is still a change
   * made mid-meeting, so the row stamps the time at the press. When the write
   * is refused the row rolls back, and a "since" left behind then hangs off
   * the note-taker that never stopped being current: the fold reads as though
   * the OLD method had been chosen at the moment the new one was refused.
   */
  it('a refused bot switch takes its "since" back with the method', async () => {
    const bot = new FakeBot();
    bot.set('recording', ['Ann']);
    // Every write on this doc is refused, which is the path under test.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))),
    );
    // Put back before the next test mounts: nothing else in this file expects
    // a server that refuses everything.
    cleanups.push(() => vi.unstubAllGlobals());
    const h = mount(undefined, { bot, offeredNotesMethods });
    // A live bot puts the Record button on the MENU, where the fold lives.
    h.record().click();
    h.pop().querySelector<HTMLButtonElement>('.meeting-notetaker .meeting-adv-head')?.click();
    h.pick('Ledger · Opus');
    await vi.waitFor(() =>
      expect(h.pop().querySelector('.meeting-notetaker .meeting-adv-value')?.textContent).toBe(
        'Original',
      ),
    );
    // The row that is current says what it costs and nothing else: no switch
    // happened, so there is no moment for it to have happened at.
    const rows = [...h.pop().querySelectorAll('.meeting-notetaker .meeting-choice')];
    const current = rows.find((el) => el.querySelector('input')?.checked);
    expect(current?.querySelector('.meeting-choice-detail')?.textContent ?? '').not.toContain(
      'since',
    );
  });

  it('a single refused switch still puts the row back where it was', async () => {
    const h = await liveWithFold();
    h.pick('Ledger · Opus');
    h.sockets[0]?.serve({ type: 'notes_method', method: 'ledger-opus', recorded: false });
    expect(shows(h)).toEqual({ head: 'Original', checked: 'original' });
  });
});

/**
 * Recording is a WRITE, so a reader who cannot write the doc is not offered it.
 *
 * Every minute of a recording lands in this doc: the transcript, and the notes
 * the meeting mints as it runs. A visitor who cannot write was still shown a
 * live Record Audio button, and found out at the server. The doc's write gate
 * already disables every control carrying `data-write-control`, and `app.ts`
 * mounts the meeting before it runs that gate, so the two buttons only have to
 * carry the attribute to arrive disabled.
 */
describe('Record Audio under the doc write gate', () => {
  /** The strip docked in a bar, as the doc mount docks it in the top bar. */
  function docked() {
    const bar = document.createElement('div');
    document.body.append(bar);
    const h = mount(undefined, { dock: bar });
    return {
      h,
      bar,
      record: () => bar.querySelector('.meeting-record') as HTMLButtonElement,
      options: () => bar.querySelector('.meeting-record-options') as HTMLButtonElement,
    };
  }

  it('offers both buttons to somebody who can write', () => {
    const d = docked();
    expect(d.record().disabled).toBe(false);
    expect(d.options().disabled).toBe(false);
  });

  it('disables both once the doc is locked to reading', () => {
    const d = docked();
    lockDocToReading({ root: d.bar });
    expect(d.record().disabled).toBe(true);
    expect(d.options().disabled).toBe(true);
    expect(d.record().getAttribute('aria-label')).toBe('Sign in to edit this doc');
  });

  /** THE CONTROL: the gate reaches only what claims to be a write control, so
   *  a neighbouring button in the same bar is left alone. */
  it('leaves a control that is not a write control enabled', () => {
    const d = docked();
    const other = document.createElement('button');
    d.bar.append(other);
    lockDocToReading({ root: d.bar });
    expect(other.disabled).toBe(false);
  });
});
