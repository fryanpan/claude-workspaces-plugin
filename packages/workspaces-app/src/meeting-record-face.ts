/**
 * What the Record button is about to capture, in words.
 *
 * WHY IT EXISTS. On 16 September a sixteen-second pause came back in solo
 * mode: the press that restarted the recording was handled as "nobody else is
 * on this doc", which assigned `solo` over a `conversation` already chosen,
 * and speaker attribution ended for three quarters of the meeting. Nothing on
 * screen said so before the press or after it, because the button said
 * "Record Audio" in every state a recording could be about to start in.
 *
 * TWO AXES, NAMED BY BRYAN: what it listens to (microphone, this Mac's audio,
 * a bot sent to a call) and how many voices it listens for (just me,
 * multiple). They are the two facts that change what is recorded and what is
 * billed, so they are the two the button carries.
 *
 * IT IS PURE. No DOM, no state — the strip owns both. This module is the
 * vocabulary: which word stands for which choice, what the button reads in
 * each state, and every face it can wear, which is what the hidden sizer that
 * holds the button's one width is built from.
 */
import type { CaptureMode } from '@claude-workspaces/core';

/**
 * The source axis as the button names it. `mic+system` is the chooser's Mac
 * Audio, which means the microphone AS WELL — see `ChooserState.chooseSource`
 * — so the word is about what is ADDED, not what replaces the room.
 */
export type RecordSource = 'mic' | 'mic+system' | 'bot';

/** One word per source, short enough to sit under "Record Audio". */
export const SOURCE_WORD: Record<RecordSource, string> = {
  mic: 'Microphone',
  'mic+system': 'Mac audio',
  bot: 'Meeting link',
};

/** One word per voice count. The chooser's cards spell them out; this is the
 *  compact form the button wears. */
export const VOICES_WORD: Record<CaptureMode, string> = {
  solo: 'Just me',
  conversation: 'Multiple',
};

/** The button's headline in each state. */
export const RECORD_LABEL: { idle: string; live: string } = {
  idle: 'Record Audio',
  live: 'Recording',
};

/** The one line under the headline: source, then voices. */
export function recordSetting(source: RecordSource, mode: CaptureMode): string {
  return `${SOURCE_WORD[source]} · ${VOICES_WORD[mode]}`;
}

/** What the whole control reads, in words and to a screen reader. */
export interface RecordFace {
  /** The headline: Record Audio, or Recording. */
  label: string;
  /** The setting line: "Microphone · Multiple". */
  setting: string;
  /** The same two facts spelled out, because "·" is not read aloud. */
  ariaLabel: string;
  /** The hover title, which says both facts and what a press does. */
  title: string;
}

export function recordFace(of: {
  /** True once a capture is running: the face describes what IS being
   *  captured rather than what the next press would capture. */
  recording: boolean;
  source: RecordSource;
  mode: CaptureMode;
}): RecordFace {
  const label = of.recording ? RECORD_LABEL.live : RECORD_LABEL.idle;
  const setting = recordSetting(of.source, of.mode);
  const voices = of.mode === 'conversation' ? 'multiple speakers' : 'just me';
  return {
    label,
    setting,
    ariaLabel: `${label} — ${SOURCE_WORD[of.source].toLowerCase()}, ${voices}`,
    title: of.recording ? `Recording ${setting} — open controls` : `Record audio — ${setting}`,
  };
}

/** Every source the button can name, in the order the chooser offers them. */
export const RECORD_SOURCES: readonly RecordSource[] = ['mic', 'mic+system', 'bot'];
/** Every voice count, cheapest first. */
export const RECORD_MODES: readonly CaptureMode[] = ['solo', 'conversation'];

/**
 * Every headline and every setting line the button can ever show.
 *
 * The button holds ONE width across every state, which it does by carrying a
 * hidden copy of all of these at zero height: the widest one sets the width
 * and no change of state can move it. Deriving the list rather than naming
 * the longest string means a reworded source, a new one, or a font whose
 * widest word is not the longest word cannot silently make the pill resize
 * again.
 */
export function everyRecordLabel(): string[] {
  return [RECORD_LABEL.idle, RECORD_LABEL.live];
}

export function everyRecordSetting(): string[] {
  const out: string[] = [];
  for (const source of RECORD_SOURCES) {
    for (const mode of RECORD_MODES) out.push(recordSetting(source, mode));
  }
  return out;
}

/**
 * The mark that stands for each source where the words do not fit — below
 * 640px, where Bryan's phone ruling already took the label away. A microphone,
 * a screen, a camera feeding a window.
 */
export const SOURCE_GLYPH: Record<RecordSource, string> = {
  mic: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.6" y="1.6" width="4.8" height="8" rx="2.4" fill="currentColor"/><path d="M3.4 7.4a4.6 4.6 0 0 0 9.2 0M8 12v2.4M5.6 14.4h4.8" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>',
  'mic+system':
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.4" y="2.6" width="13.2" height="8.8" rx="1.6" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M5.6 14h4.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M6 5.6v3.2l2.6-1.6z" fill="currentColor"/></svg>',
  bot: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.3" y="4" width="8.6" height="8" rx="1.6" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M10.6 8.4l3.8-2.5v4.9l-3.8-2.4z" fill="currentColor"/></svg>',
};

/** The mark that stands for each voice count at the same widths: one head, or
 *  two with the second set back. */
export const VOICES_GLYPH: Record<CaptureMode, string> = {
  solo: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.2" r="2.6" fill="currentColor"/><path d="M2.8 14c0-2.9 2.3-4.6 5.2-4.6s5.2 1.7 5.2 4.6z" fill="currentColor"/></svg>',
  conversation:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5.4" cy="5.2" r="2.4" fill="currentColor"/><path d="M0.9 13.6c0-2.6 2-4.2 4.5-4.2s4.5 1.6 4.5 4.2z" fill="currentColor"/><circle cx="11.6" cy="5.8" r="2" fill="currentColor" opacity="0.55"/><path d="M8.6 13.6c0-2.2 1.6-3.6 3.5-3.6s3.4 1.4 3.4 3.6z" fill="currentColor" opacity="0.55"/></svg>',
};
