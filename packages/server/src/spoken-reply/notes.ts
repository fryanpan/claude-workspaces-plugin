/**
 * Which spoken points are worth a note, and the note's written wording.
 *
 * A note is the part of the answer worth keeping on the page after the voice
 * has gone: something waiting on the listener, or a change the board just
 * made. Counts, "nothing waiting on you" and lists of what is in progress are
 * said and not noted — the board already shows them, and a note for every
 * sentence would be no emphasis at all.
 *
 * The wording is for reading, so it may differ from what is said: the
 * sentence's full stop goes, the count moves into brackets, and what the
 * listener has to act on comes first.
 */
import type { SpokenPoint } from '@claude-workspaces/core/spoken-reply';
import { withoutCues } from './cues.ts';

export interface NoteContext {
  /** The router's word for what answered. */
  route: string;
  /** Point 0: the one an action's result is reported in. */
  first: boolean;
}

const stop = (s: string): string => s.replace(/[.!]\s*$/, '').trim();

export function noteFor(sentence: string, ctx: NoteContext): string | undefined {
  const s = sentence.trim();
  if (s.endsWith('?')) return undefined;

  // The board brief: "Waiting on you: 2 — “a” on “b”; “c” on “d”."
  const counted = s.match(/^Waiting on you: (\d+) — (.+)$/);
  if (counted) return `Waiting on you (${counted[1]}): ${stop(counted[2] ?? '')}`;
  if (/^Waiting on you: /.test(s)) return stop(s);

  // A doc in view: "“Plan”: 2 waiting on you — “a” (Bob); “b” (Alice)."
  const onDoc = s.match(/^(“.+?”): (\d+) waiting on you — (.+)$/);
  if (onDoc) return `${onDoc[1]}, waiting on you (${onDoc[2]}): ${stop(onDoc[3] ?? '')}`;

  // A task in view that needs something: the need first.
  const needs = s.match(/^(“.+?”) is (.+?), (with .+?|unassigned), needs (.+)$/);
  if (needs) return `${needs[1]} needs ${stop(needs[4] ?? '')} (${needs[2]}, ${needs[3]})`;

  if (ctx.route === 'fast-path-action' && ctx.first) {
    if (/ is already /.test(s)) return undefined;
    const moved = s.match(/^Moved "(.+)" from (.+) to (.+?)\.?$/);
    if (moved) return `“${moved[1]}”: ${moved[2]} → ${moved[3]}`;
    const assigned = s.match(/^Assigned "(.+)" to (.+?)\.?$/);
    if (assigned) return `“${assigned[1]}” assigned to ${assigned[2]}`;
    return stop(s);
  }
  return undefined;
}

/** Each point with its note, when it earns one. */
export function withNotes(says: readonly string[], route: string): SpokenPoint[] {
  return says.map((say, i) => {
    const note = noteFor(withoutCues(say), { route, first: i === 0 });
    return note ? { say, note } : { say };
  });
}
