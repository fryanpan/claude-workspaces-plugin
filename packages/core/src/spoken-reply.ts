/**
 * The board mic's spoken reply: the wire between the board page and the
 * server's `WS /workspaces/<ws>/voice/converse`.
 *
 * In `core` because both ends read it and neither can import the other. The
 * page streams the meeting capture's PCM (16 kHz mono PCM16) up as binary
 * frames and sends the JSON below as text frames; the server answers with
 * JSON, and with the reply's voice as binary PCM16 at `SPOKEN_OUTPUT_RATE`
 * between an `audio-start` and an `audio-end`.
 *
 * FOUR SETUPS behind one switch, so they can be heard side by side on the
 * same board (the voice plan, "Which voice API"):
 *
 *   1  Soniox listens and Soniox speaks.
 *   2  Soniox listens and ElevenLabs Flash speaks.
 *   3  Gemini Live hears and speaks, and asks the board what to say.
 *   4  ElevenLabs Agents hears, takes turns and speaks, and asks this
 *      server's custom-LLM route what to say.
 *
 * In every setup the words of the reply come from the board mic's own router
 * (`voice.ts`), so what a setup changes is the ears and the voice, not the
 * answer.
 */

import { type SpokenDecide, type SpokenDecided, parseSpokenDecided } from './spoken-review.ts';

export type { SpokenDecide, SpokenDecided, SpokenReviewTarget } from './spoken-review.ts';
export { reviewAnswerRequest, spokenDecisionRequest } from './spoken-review.ts';

export type SpokenSetup = 1 | 2 | 3 | 4;
export const SPOKEN_SETUPS: readonly SpokenSetup[] = [1, 2, 3, 4];

/** A setup's number as a JSON key. */
export type SpokenSetupKey = '1' | '2' | '3' | '4';

export function spokenSetupKey(s: SpokenSetup): SpokenSetupKey {
  return String(s) as SpokenSetupKey;
}

export const SPOKEN_SETUP_NAMES: Record<SpokenSetup, string> = {
  1: 'Soniox alone',
  2: 'Soniox + ElevenLabs',
  3: 'Gemini Live',
  4: 'ElevenLabs Agents',
};

/** The switch's tooltips: who hears and who speaks. */
export const SPOKEN_SETUP_TITLES: Record<SpokenSetup, string> = {
  1: 'Soniox listens and speaks',
  2: 'Soniox listens, ElevenLabs Flash speaks',
  3: 'Gemini Live hears and speaks',
  4: 'ElevenLabs Agents hears, takes turns and speaks',
};

/**
 * How a question ends. `hold`: when the mic is released. `tap`: when the
 * listener decides the speaker has finished — the end-of-speech detection the
 * long-pause test is about.
 */
export type SpokenMode = 'hold' | 'tap';

/** The rate setups 1-3's voice arrives at. All three vendors offer 24 kHz
 *  PCM16, so the page plays one format whichever setup spoke. Setup 4 plays
 *  at the rate its agent is configured for, named in `audio-start`. */
export const SPOKEN_OUTPUT_RATE = 24_000;

/** The longest a spoken part may be, in words. The plan's first risk is
 *  talking too much; this is the hard cap under the two-sentence rule. */
export const SPOKEN_MAX_WORDS = 40;

/**
 * One point of the spoken part — a sentence said aloud — and, when the point
 * is worth keeping, its note: the written wording of the same point, which may
 * differ from what is said, since reading and hearing want different words.
 * The page shows a note as its point starts to play, never after.
 */
export interface SpokenPoint {
  say: string;
  note?: string;
}

/**
 * How long a silence counts as the speaker's pause (the server's
 * `pause-gate.ts`): after a phrase that is not yet a sentence, and after one
 * that is, when the listener has not called the end of the utterance first.
 * The page may send its own with each `start`, so the owner can try values
 * during a meeting.
 */
export interface SpokenPause {
  finishedMs: number;
  unfinishedMs: number;
}

/** The owner's defaults (2026-10-02). */
export const SPOKEN_PAUSE_DEFAULT: SpokenPause = { finishedMs: 1500, unfinishedMs: 3000 };
/** The range either wait may be set to. */
export const SPOKEN_PAUSE_MIN_MS = 500;
export const SPOKEN_PAUSE_MAX_MS = 10_000;

function pauseWait(v: unknown): number | undefined {
  return typeof v === 'number' &&
    Number.isFinite(v) &&
    v >= SPOKEN_PAUSE_MIN_MS &&
    v <= SPOKEN_PAUSE_MAX_MS
    ? Math.round(v)
    : undefined;
}

/** A page's pause setting, or undefined when either wait is out of range. */
export function parseSpokenPause(raw: unknown): SpokenPause | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  const finishedMs = pauseWait(p.finishedMs);
  const unfinishedMs = pauseWait(p.unfinishedMs);
  return finishedMs !== undefined && unfinishedMs !== undefined
    ? { finishedMs, unfinishedMs }
    : undefined;
}

export interface SpokenAuthor {
  id: string;
  name: string;
  kind?: string;
}

export type SpokenClientMessage =
  | {
      type: 'start';
      setup: SpokenSetup;
      mode: SpokenMode;
      /** Where the speaker is: the same object `POST /voice` takes. Parsed by
       *  the server's own `parseVoiceContext`, never trusted here. */
      context?: unknown;
      author?: SpokenAuthor;
      /** `meeting`: hear the planning meeting recording on the context's doc
       *  instead of this socket's own audio (the server's `meeting-ears.ts`).
       *  The page then sends no audio. */
      ears?: 'meeting';
      /** The page's pause setting; absent, the server's defaults. */
      pause?: SpokenPause;
      /** Talk to this agent rather than the board's router: an agent id on
       *  the socket's board, checked there (`agent-conversation.ts`). */
      agent?: string;
    }
  | { type: 'end' }
  | { type: 'stop' }
  /** The pause setting changed mid-meeting: the next wait uses it. */
  | { type: 'pause'; pause: SpokenPause }
  /** A choice tapped instead of said: answered as if it had been heard, on
   *  the setup the last `start` named. */
  | { type: 'say'; text: string }
  | {
      type: 'timing';
      /** End of the question to the first spoken word, as the page heard it. */
      delayMs: number;
      /** End of the question to the listener calling it over. */
      endpointMs?: number;
      /** Listener calling it over to the written reply arriving. */
      replyMs?: number;
      /** Written reply arriving to the first spoken word. */
      audioMs?: number;
      /** Per noted point, in order: when its note showed minus when its
       *  point's first word played. Zero or below is the note in step. */
      noteLeadMs?: number[];
    }
  /** How the page's write of a `reply.decide` went (`spoken-review.ts`). */
  | SpokenDecided;

export interface SpokenTimingRow {
  n: number;
  medianMs: number;
  p90Ms: number;
  lastMs: number;
}

/** Per setup, keyed by the setup's number as a string (JSON keys). */
export type SpokenTimingSummary = Partial<Record<SpokenSetupKey, SpokenTimingRow>>;

/**
 * A setup the server has the keys for but will not run yet, with the one
 * line that says why — shown on the page when it is chosen. Keyed like
 * `SpokenTimingSummary`.
 */
export type SpokenHeldSetups = Partial<Record<SpokenSetupKey, string>>;

export type SpokenServerMessage =
  | { type: 'ready'; setups: SpokenSetup[]; held?: SpokenHeldSetups; timings: SpokenTimingSummary }
  | { type: 'heard'; text: string }
  | { type: 'turn-end'; text: string }
  /** The question reached the answerer, which is working on it: shown until
   *  the reply arrives, so the speaker can look away. */
  | { type: 'working' }
  | {
      type: 'reply';
      /** Said aloud: the first two sentences, or the one question. Empty when
       *  nothing was heard. */
      spoken: string;
      /** Written only, one line each, below the spoken part. */
      detail: string[];
      /** `spoken`, point by point, with each point's note when it has one.
       *  The notes themselves land by `note` frames, in step with the voice. */
      points?: SpokenPoint[];
      /** The spoken part is a question, and the page waits for its answer. */
      asking: boolean;
      /** When asking, the answers the page may offer as buttons. */
      choices?: string[];
      /** Which route answered — the router's own word, or `none`. */
      route: string;
      navigate?: string;
      /** A review decision for the page to write, or take back. */
      decide?: SpokenDecide;
      /** The planning voice's question, still open while `spoken` talks it
       *  over rather than asking it: the page keeps showing the question. */
      question?: string;
    }
  /** Point `point`'s note, sent just before that point's audio — the page
   *  shows it as the point starts to play. */
  | { type: 'note'; point: number; text: string }
  | { type: 'audio-start'; sampleRate: number }
  | { type: 'audio-end' }
  /** A meeting heard by this socket went on talking after the pause: the
   *  voice is stopped, and the page stops playing at once and shows the
   *  socket listening again. The server is already hearing the new turn, so
   *  the page sends no `start`; an `audio-end` for the stopped reply may
   *  still follow, and ends nothing. */
  | { type: 'cut-in' }
  /** A meeting's "Claude, …" went to the lead: `label`, a few words of the
   *  request, is shown until its answer is said, then `null` clears it. */
  | { type: 'doing'; label: string | null }
  | { type: 'timings'; summary: SpokenTimingSummary }
  | { type: 'error'; message: string };

const MAX_TIMING_MS = 120_000;
const MAX_AUTHOR_FIELD = 200;
const MAX_SAY_CHARS = 200;
/** The server's own agent-id rule (`isValidAgentId`): no space, no slash. */
const AGENT_ID = /^[^\s/\\]{1,200}$/;

function isSetup(v: unknown): v is SpokenSetup {
  return v === 1 || v === 2 || v === 3 || v === 4;
}

function timingField(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TIMING_MS
    ? Math.round(v)
    : undefined;
}

const MAX_NOTE_LEADS = 8;

/** A note's lead may be negative (early), so it has its own bound. */
function noteLeads(v: unknown): number[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_NOTE_LEADS) return undefined;
  const out: number[] = [];
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > MAX_TIMING_MS) {
      return undefined;
    }
    out.push(Math.round(n));
  }
  return out;
}

function authorOf(raw: unknown): SpokenAuthor | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const a = raw as Record<string, unknown>;
  const id = typeof a.id === 'string' ? a.id.trim().slice(0, MAX_AUTHOR_FIELD) : '';
  const name = typeof a.name === 'string' ? a.name.trim().slice(0, MAX_AUTHOR_FIELD) : '';
  if (!id || !name) return undefined;
  const kind = typeof a.kind === 'string' ? a.kind.slice(0, 40) : undefined;
  return { id, name, ...(kind ? { kind } : {}) };
}

/**
 * A text frame from the page, or null. Everything the server acts on is
 * checked here: an unknown type, a setup outside 1–4, a timing that is not a
 * plausible number of milliseconds — all null, and the server ignores null.
 */
export function parseSpokenClientMessage(text: string): SpokenClientMessage | null {
  if (text.length > 20_000) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'start': {
      if (!isSetup(m.setup)) return null;
      const mode: SpokenMode = m.mode === 'tap' ? 'tap' : 'hold';
      const author = authorOf(m.author);
      const pause = parseSpokenPause(m.pause);
      const agent = typeof m.agent === 'string' && AGENT_ID.test(m.agent) ? m.agent : undefined;
      return {
        type: 'start',
        setup: m.setup,
        mode,
        ...(m.context !== undefined ? { context: m.context } : {}),
        ...(author ? { author } : {}),
        ...(m.ears === 'meeting' ? { ears: 'meeting' as const } : {}),
        ...(pause ? { pause } : {}),
        ...(agent ? { agent } : {}),
      };
    }
    case 'end':
      return { type: 'end' };
    case 'stop':
      return { type: 'stop' };
    case 'pause': {
      const pause = parseSpokenPause(m.pause);
      return pause ? { type: 'pause', pause } : null;
    }
    case 'say': {
      const text = typeof m.text === 'string' ? m.text.trim().slice(0, MAX_SAY_CHARS) : '';
      return text ? { type: 'say', text } : null;
    }
    case 'timing': {
      const delayMs = timingField(m.delayMs);
      if (delayMs === undefined) return null;
      const endpointMs = timingField(m.endpointMs);
      const replyMs = timingField(m.replyMs);
      const audioMs = timingField(m.audioMs);
      const noteLeadMs = noteLeads(m.noteLeadMs);
      return {
        type: 'timing',
        delayMs,
        ...(endpointMs !== undefined ? { endpointMs } : {}),
        ...(replyMs !== undefined ? { replyMs } : {}),
        ...(audioMs !== undefined ? { audioMs } : {}),
        ...(noteLeadMs !== undefined ? { noteLeadMs } : {}),
      };
    }
    case 'decided':
      return parseSpokenDecided(m);
    default:
      return null;
  }
}

/** A server frame, or null — the page's half of the same check. */
export function parseSpokenServerMessage(text: string): SpokenServerMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const t = (raw as { type?: unknown }).type;
  const known = [
    'ready',
    'heard',
    'turn-end',
    'working',
    'reply',
    'note',
    'audio-start',
    'audio-end',
    'cut-in',
    'doing',
    'timings',
    'error',
  ];
  return typeof t === 'string' && known.includes(t) ? (raw as SpokenServerMessage) : null;
}

/**
 * The planning voice's cursor: the presence field the server sets on its own
 * awareness state for a doc while it asks about some of the doc's words, and
 * every open view reads to scroll there and highlight them. The server's
 * state carries no `user`, so nothing that counts the people on a doc counts
 * it. `seq` grows with every question, so a page scrolls again when the same
 * words are asked about twice.
 */
export const AGENT_FOCUS_FIELD = 'agentFocus';

export interface AgentFocus {
  /** The block holding the words. */
  blockId: string;
  /** The words, as the block held them when asked. */
  quote: string;
  name: string;
  color: string;
  seq: number;
}

/** A presence state's focus, when it carries a well-formed one. */
export function parseAgentFocus(raw: unknown): AgentFocus | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const { blockId, quote, name, color, seq } = f;
  if (typeof blockId !== 'string' || !blockId || blockId.length > 200) return null;
  if (typeof quote !== 'string' || typeof name !== 'string') return null;
  if (typeof color !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(color)) return null;
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
  return { blockId, quote: quote.slice(0, 500), name: name.slice(0, 40), color, seq };
}
