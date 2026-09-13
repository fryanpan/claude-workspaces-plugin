/**
 * Voice feedback: a person talks about the page in front of them, and what
 * they say lands as comments anchored to the elements they are talking about.
 *
 * This is the VOCABULARY both ends of the socket share — the frames, the
 * target catalog the page sends so the server can say which element was
 * meant, and the note a spoken comment carries (its clip and its raw words).
 * Reading an untrusted frame into one of these is here too, because only the
 * server reads client frames and it must drop anything malformed rather than
 * guess: a wrong guess reaches a file name or a billed engine session.
 *
 * The audio itself is the meeting path's wire format (PCM16LE mono at
 * `MEETING_SAMPLE_RATE`), so one capture serves both.
 */

/**
 * One element on the page the speaker could mean. `i` is its index in the
 * catalog the page sent, and the only name the server ever uses for it: the
 * server never sees the DOM, and the page is the one place an index turns
 * back into an element.
 */
export interface VoiceTarget {
  i: number;
  /** Lower-case tag name. */
  tag: string;
  /** Its visible words, trimmed and capped. */
  text: string;
  /** `aria-label`, `title`, `alt` or `placeholder` — words a person may say
   *  that are not on screen. */
  label?: string;
  /** `id` and class names — a mock's own vocabulary ("goal", "chip"). */
  hint?: string;
  /** The nearest enclosing target, so "the chip on the blocked task" can be
   *  told from the chip on the done one. */
  parent?: number;
}

export type VoiceClientMessage =
  | { type: 'start'; sampleRate: number; targets: VoiceTarget[] }
  /** The page changed under the speaker; the catalog is replaced. */
  | { type: 'targets'; targets: VoiceTarget[] }
  /** The person tapped an element: the NEXT words go there. `null` is the
   *  page as a whole. */
  | { type: 'pin'; target: number | null }
  /** The person moved a comment to the element they meant. It stays there. */
  | { type: 'move'; key: string; target: number | null }
  /** The page posted comment `key` as this thread — recorded in the log. */
  | { type: 'posted'; key: string; threadId: string }
  | { type: 'stop' };

/** A spoken comment as the server currently understands it. */
export interface VoiceCommentFrame {
  type: 'comment';
  /** Stable for the life of the comment: a later frame with the same key
   *  replaces the earlier one (the words grew, or it settled). */
  key: string;
  /** The tidied words. */
  text: string;
  /** Catalog index, or `null` for the page as a whole. */
  target: number | null;
  /** Exactly what was heard for this comment. */
  raw: string;
  /** Where its audio is — see `VoiceNote.clip`. */
  clip: string;
  /** Settled: no more words will join it. */
  final: boolean;
}

export type VoiceServerMessage =
  | { type: 'ready'; segment: number }
  | { type: 'unavailable'; reason: string }
  /** The raw words of the last few seconds, still-provisional ones included. */
  | { type: 'heard'; text: string }
  | VoiceCommentFrame
  | { type: 'stopped' }
  | { type: 'error'; message: string };

/**
 * What a spoken comment keeps at its foot. Rides on the comment itself, so
 * every surface that reads the thread can offer it without asking the voice
 * log.
 */
export interface VoiceNote {
  /** Same-origin URL of the recording, with a media fragment for this
   *  comment's stretch of it: `…/voice-feedback/seg-3.wav#t=12.4,31`. */
  clip: string;
  /** The words as heard, before tidying. */
  raw: string;
}

/** The longest catalog a page may send. A page with more has its first
 *  elements in document order, which is where people look first. */
export const MAX_VOICE_TARGETS = 400;
/**
 * The highest index a target may carry. Above the catalog's length because
 * an element keeps its index for a whole recording: a page that changes under
 * the speaker sends a new catalog in which the elements already named keep
 * their numbers and new ones take the next, so a comment the server is still
 * growing does not come to point at whatever moved into its old slot.
 */
export const MAX_VOICE_TARGET_INDEX = 99_999;
/** Characters of visible text kept per target. */
export const VOICE_TARGET_TEXT = 80;
/** Raw words kept on one comment. */
export const MAX_VOICE_RAW = 8_000;

const CLIP_RE =
  /^\/workspaces\/[^/?#\s]+\/docs\/[^/?#\s]+\/voice-feedback\/seg-\d{1,6}\.wav#t=\d{1,6}(\.\d{1,3})?,\d{1,6}(\.\d{1,3})?$/;

/**
 * A stored or posted note, or nothing. The clip must point at a recording
 * this server serves — a note is rendered as an `<audio src>`, and a comment
 * is written by whatever peer posted it.
 */
export function readVoiceNote(raw: unknown): VoiceNote | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { clip, raw: words } = raw as Record<string, unknown>;
  if (typeof clip !== 'string' || !CLIP_RE.test(clip)) return undefined;
  if (typeof words !== 'string' || words.length > MAX_VOICE_RAW) return undefined;
  return { clip, raw: words };
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_VOICE_TARGET_INDEX;
}

/** A catalog, with every malformed entry dropped. */
export function parseVoiceTargets(raw: unknown): VoiceTarget[] | null {
  if (!Array.isArray(raw)) return null;
  const out: VoiceTarget[] = [];
  for (const t of raw.slice(0, MAX_VOICE_TARGETS)) {
    if (!t || typeof t !== 'object') continue;
    const m = t as Record<string, unknown>;
    const tag = str(m.tag, 20);
    if (!isIndex(m.i) || !tag || !/^[a-z][a-z0-9-]*$/.test(tag)) continue;
    const label = str(m.label, VOICE_TARGET_TEXT);
    const hint = str(m.hint, VOICE_TARGET_TEXT);
    out.push({
      i: m.i,
      tag,
      text: str(m.text, VOICE_TARGET_TEXT) ?? '',
      ...(label ? { label } : {}),
      ...(hint ? { hint } : {}),
      ...(isIndex(m.parent) ? { parent: m.parent } : {}),
    });
  }
  return out;
}

/** Parse a client frame, or null for anything malformed. */
export function parseVoiceClientMessage(raw: unknown): VoiceClientMessage | null {
  if (typeof raw !== 'string') return null;
  let m: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    m = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const target = m.target === null ? null : isIndex(m.target) ? m.target : undefined;
  const key = typeof m.key === 'string' && /^v\d{1,6}$/.test(m.key) ? m.key : undefined;
  switch (m.type) {
    case 'stop':
      return { type: 'stop' };
    case 'start': {
      const targets = parseVoiceTargets(m.targets);
      if (m.sampleRate !== 16_000 || !targets) return null;
      return { type: 'start', sampleRate: 16_000, targets };
    }
    case 'targets': {
      const targets = parseVoiceTargets(m.targets);
      return targets ? { type: 'targets', targets } : null;
    }
    case 'pin':
      return target === undefined ? null : { type: 'pin', target };
    case 'move':
      return target === undefined || !key ? null : { type: 'move', key, target };
    case 'posted':
      return key && typeof m.threadId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(m.threadId)
        ? { type: 'posted', key, threadId: m.threadId }
        : null;
    default:
      return null;
  }
}

/** Parse a server frame on the page, or null. The server is trusted; this
 *  only keeps a frame from a newer server from reaching a renderer half-read. */
export function parseVoiceServerMessage(raw: unknown): VoiceServerMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    if (m.type === 'comment') {
      return typeof m.key === 'string' &&
        typeof m.text === 'string' &&
        typeof m.raw === 'string' &&
        typeof m.clip === 'string' &&
        (m.target === null || typeof m.target === 'number')
        ? (m as unknown as VoiceCommentFrame)
        : null;
    }
    if (['ready', 'unavailable', 'heard', 'stopped', 'error'].includes(m.type as string)) {
      return m as unknown as VoiceServerMessage;
    }
    return null;
  } catch {
    return null;
  }
}
