/**
 * The cast a rerun starts with: a finished meeting on the doc whose voices
 * somebody named.
 *
 * WHY A RERUN NEEDS THIS AT ALL. `runRerun` opens a fresh temp data dir for
 * every run, so the doc it creates has held no meeting before and nobody has
 * ever named a voice on it. The name a turn reaches the composer under is
 * `speakerDisplayName(label, names)`, and `names` for a new meeting starts as
 * `docSpeakerNames` — every name an EARLIER meeting on this doc gave. Over an
 * empty index that is `{}`, so every voice reads as its placeholder, every
 * tag the notes write points at "Speaker A", and `unnamedVoiceBullets` reads
 * near 100% unnamed. On both builds. A replay could not tell a note-taker
 * that carries names across sessions from one that does not, which is the one
 * thing the speaker-continuity work is judged on.
 *
 * SO THE FLAG SEEDS HISTORY, NOT THIS MEETING. `--cast A=Riverbend` writes a
 * finished meeting with that cast into the doc's index before the replay's
 * own meeting starts. The rerun then measures exactly the carry: the engine
 * hands out "A" afresh, and whether the notes come out saying Riverbend or
 * "Speaker A" is decided by `docSpeakerNames` and the session's carry of it —
 * the code under test — rather than by a naming gesture inside the run, which
 * would name the voices on any build and so measure nothing.
 *
 * IT IS A FILE WRITE, NOT A ROUTE, and deliberately so. The public verbs name
 * a voice of a meeting that HAPPENED — `name_speaker` on the live socket,
 * `POST …/speakers` after it — and neither can invent the meeting before it.
 * A rerun's data dir is a throwaway this harness made seconds earlier, and
 * the preference file `runRerun` already writes into it with
 * `writeNotesMethod` is the same kind of setup: state the product would have,
 * put there so that the product's own read of it is what the run exercises.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { meetingIdFor, meetingIndexPath } from '../packages/server/src/meetings.ts';

/** Engine label → the name a person gave that voice. */
export type SeededCast = Readonly<Record<string, string>>;

/** The cast as one line of a log or a report header. */
export function castLine(cast: SeededCast): string {
  return Object.entries(cast)
    .map(([label, name]) => `${label}=${name}`)
    .join(', ');
}

/**
 * Write that meeting, and answer the id it was given.
 *
 * TWO LINES IN THE APPEND-ONLY SHAPE THE INDEX ALREADY HAS — the start, then
 * the end carrying the cast — which is how a meeting whose voices were named
 * during it lands on disk. `engine` reads `seeded-cast` so a person opening a
 * `--keep` data dir can see at once that this meeting was placed there rather
 * than held.
 *
 * It costs the run one segment: the replay's meeting is this doc's second, so
 * its audio files and its raw-transcript heading say `Segment 2`. That is
 * what the index now describes. The alternative — a naming line for a meeting
 * the index has no record of — would be a doc whose cast came from nowhere.
 */
export function seedCast(dataDir: string, docId: string, cast: SeededCast, at: number): string {
  const meetingId = meetingIdFor(docId, at);
  const path = meetingIndexPath(dataDir, docId);
  mkdirSync(dirname(path), { recursive: true });
  const lines = [
    {
      meetingId,
      docId,
      startedAt: at,
      engine: 'seeded-cast',
      sampleRate: 0,
      mode: 'conversation',
      segment: 1,
    },
    { meetingId, endedAt: at, turns: 0, speakers: { ...cast } },
  ];
  appendFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return meetingId;
}
