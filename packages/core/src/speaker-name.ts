/**
 * What a voice is CALLED, and the one place that decides it.
 *
 * Split out of `meeting.ts` when the rules stopped being one line: a name is
 * now normalised on the way in AND on the way out, because records already
 * written carry strings that were never names. The strip, the notes, the
 * record and the composer all read this module, so they cannot disagree.
 */

import { groupLabel, parseNamespacedSpeaker } from './meeting-streams.ts';

/**
 * The default a voice reads as until somebody names it: "Speaker A" on a
 * single-stream meeting, "Room Speaker A" / "Remote Speaker A" on a
 * two-stream one, where WHICH ROOM is the only thing that tells two
 * anonymous voices apart.
 */
export function speakerPlaceholderName(label: string): string {
  const ns = parseNamespacedSpeaker(label);
  if (!ns) return `Speaker ${label}`;
  return `${groupLabel(ns.group)} Speaker ${ns.base}`;
}

/** Every placeholder shape this repo has ever rendered, so one that was
 *  saved AS a name can be recognised as the non-answer it is. */
const PLACEHOLDER_NAME = /^(?:room|remote)?\s*speaker\s+\S+$/i;

/** A trailing "(Room)" / "(Remote)", however many of them got stacked up. */
const TRAILING_GROUP = /(?:\s*\((?:Room|Remote)\))+$/i;

/**
 * The name a person actually gave this voice, or nothing.
 *
 * TWO KINDS OF NON-ANSWER ARE NORMALISED AWAY HERE, and both are on disk in
 * real meeting records because the rename prompt used to be seeded with the
 * DISPLAY name rather than the saved one (Bryan, 2026-09-09: notes reading
 * `@John (Room) (Room)`).
 *
 * - A saved name carrying the group suffix the display used to append —
 *   "John (Room)" — is just "John". Left alone, display appended a second
 *   one every time it rendered.
 * - A saved name that IS a placeholder — "Room Speaker C", kept because the
 *   prompt offered it and the person pressed OK — is not a name at all, and
 *   a voice holding one still reads as its own placeholder.
 *
 * Normalising on READ is what makes the records already written come out
 * clean; the write sites call it too, so nothing new goes in dirty.
 */
export function speakerGivenName(
  label: string,
  names: Readonly<Record<string, string>>,
): string | undefined {
  return normalizeSpeakerName(names[label]);
}

/** The bare name inside whatever was saved, or nothing if it was a
 *  placeholder, empty, or only ever a group suffix. */
export function normalizeSpeakerName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const bare = raw.replace(TRAILING_GROUP, '').trim();
  if (bare.length === 0) return undefined;
  if (PLACEHOLDER_NAME.test(bare)) return undefined;
  return bare;
}

/**
 * What a turn's speaker is called: the name the person gave that label, or
 * the placeholder until they do. One function, so the strip, the record and
 * the notes never disagree about it.
 *
 * A NAMED VOICE READS AS THE NAME ALONE. It used to keep the group on the
 * end — "Dana (Remote)" — so that a transcript line said which room somebody
 * was in. Bryan, testing a two-stream meeting on 2026-09-09, asked for it
 * gone: the suffix is noise once a voice has a name, and it was also the
 * thing the rename prompt kept feeding back into the saved name. Where a
 * voice is sitting is still on the ANONYMOUS ones, which is the case where
 * it does the work of telling two Speaker As apart.
 */
export function speakerDisplayName(label: string, names: Readonly<Record<string, string>>): string {
  return speakerGivenName(label, names) ?? speakerPlaceholderName(label);
}
