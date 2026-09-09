/**
 * Where the reassign menu's voices come from.
 *
 * The doc does not know its own meeting's cast: a note carries the labels it
 * happens to mention, and the voice you need is often the one the note got
 * WRONG — so a roster built from the doc's own tags would be missing exactly
 * the entry a correction needs. The meetings API knows: it has the names a
 * person gave and the transcript that says who said what.
 *
 * The most recent meeting only. A doc can carry several, and a tag does not
 * record which one it came from; asking every meeting for its transcript
 * would be several requests to answer one tap, and offering a voice from a
 * meeting three weeks ago is not the correction anybody is reaching for.
 */

import { type RosterVoice, speakerDisplayName, speakerRoster } from '@claude-workspaces/core';
import { api } from './doc-path.ts';

interface MeetingSummary {
  meetingId: string;
  startedAt?: number;
  speakers?: Record<string, string>;
}

/** The latest meeting's cast, with the meeting it came from. */
export interface DocSpeakers {
  meetingId: string;
  voices: RosterVoice[];
}

/** One settled turn as the meeting record carries it. */
interface RecordTurn {
  text: string;
  speaker?: string;
  ts?: number;
}

interface MeetingRecord {
  speakers?: Record<string, string>;
  transcript?: RecordTurn[];
}

/** The doc's latest meeting, record and all. Null when it has never held one. */
async function latestMeeting(
  docId: string,
  fetchImpl: typeof fetch,
): Promise<{ summary: MeetingSummary; record: MeetingRecord } | null> {
  const listed = await fetchImpl(api(`docs/${encodeURIComponent(docId)}/meetings`));
  if (!listed.ok) throw new Error(`meetings ${listed.status}`);
  const body = (await listed.json()) as { meetings?: MeetingSummary[] };
  const meetings = body.meetings ?? [];
  if (meetings.length === 0) return null;
  // Latest by start, falling back to the order the index returned when a row
  // predates `startedAt` — an older record is still a usable roster.
  const summary = meetings.reduce((best, m) =>
    (m.startedAt ?? 0) >= (best.startedAt ?? 0) ? m : best,
  );
  const detail = await fetchImpl(
    api(`docs/${encodeURIComponent(docId)}/meetings/${encodeURIComponent(summary.meetingId)}`),
  );
  if (!detail.ok) throw new Error(`meeting ${detail.status}`);
  return { summary, record: (await detail.json()) as MeetingRecord };
}

/**
 * The voices of this doc's latest meeting — and WHICH meeting, because a
 * rename after the meeting is addressed to it. Null if the doc has never
 * held one.
 */
export async function loadDocSpeakers(
  docId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DocSpeakers | null> {
  const latest = await latestMeeting(docId, fetchImpl);
  if (!latest) return null;
  const { summary, record } = latest;
  return {
    meetingId: summary.meetingId,
    voices: speakerRoster(record.transcript ?? [], record.speakers ?? summary.speakers ?? {}),
  };
}

/**
 * The doc's roster, held so a tap does not have to wait for it.
 *
 * WHY A CACHE AT ALL. `loadDocSpeakers` is two sequential requests — list the
 * doc's meetings, then fetch the latest meeting's whole record, transcript
 * and all — and the reassign menu used to make both of them at the moment the
 * person tapped a name. That is a menu with a wait in it every time it opens,
 * on an answer that is already in memory: the strip loads exactly the same
 * roster when the doc mounts.
 *
 * So the cache is shared between them. `peek` is what the menu paints on the
 * tap; `load` is the refresh behind it, and it is deduped, so a menu opened
 * during the mount's own load rides that request rather than starting a
 * second one. A failed refresh leaves the last good answer in place: what is
 * on screen came from the same server a moment ago.
 */
export interface DocSpeakersCache {
  peek(): DocSpeakers | null;
  load(): Promise<DocSpeakers | null>;
}

export function createDocSpeakersCache(
  docId: string,
  fetchImpl: typeof fetch = fetch,
): DocSpeakersCache {
  let held: DocSpeakers | null = null;
  let inFlight: Promise<DocSpeakers | null> | null = null;
  return {
    peek: () => held,
    load(): Promise<DocSpeakers | null> {
      if (inFlight) return inFlight;
      const run = loadDocSpeakers(docId, fetchImpl)
        .then((fresh) => {
          // A doc that has never held a meeting answers null, and that is an
          // answer: it replaces whatever was held.
          held = fresh;
          return fresh;
        })
        .finally(() => {
          if (inFlight === run) inFlight = null;
        });
      inFlight = run;
      return run;
    },
  };
}

/** The words of this doc's latest meeting, ready to render. */
export interface DocTranscript {
  meetingId: string;
  /** `[HH:MM:SSZ] Rowan Pike: words` — the raw record's own grammar, minus
   *  its leading bullet, so the panel can render one line per turn. */
  lines: string[];
}

/**
 * WHAT THE MEETING ACTUALLY HEARD, for the panel to offer once it is over.
 *
 * The notes are the reviewed record and the doc carries them; this is the
 * unreviewed one, and until now the only copy a person could reach was the
 * `-raw-transcript.md` file beside the server's data dir — which is to say,
 * nowhere, for anyone not on the box. A bot meeting made that plain: the
 * words went past and left no trace anybody could open.
 *
 * Fetched when the panel is opened rather than held from mount, so a meeting
 * that has just ended is the one it shows.
 */
export async function loadDocTranscript(
  docId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DocTranscript | null> {
  const latest = await latestMeeting(docId, fetchImpl);
  if (!latest) return null;
  const names = latest.record.speakers ?? latest.summary.speakers ?? {};
  const turns = latest.record.transcript ?? [];
  return {
    meetingId: latest.summary.meetingId,
    lines: turns.map((turn) => {
      const who =
        turn.speaker === undefined ? 'Speaker 1' : speakerDisplayName(turn.speaker, names);
      const clock =
        turn.ts === undefined ? '' : `[${new Date(turn.ts).toISOString().slice(11, 19)}Z] `;
      return `${clock}${who}: ${turn.text.replace(/\s*\n\s*/g, ' ').trim()}`;
    }),
  };
}

/** The voices of this doc's latest meeting, or none if it has never had one. */
export async function loadDocVoices(
  docId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RosterVoice[]> {
  return (await loadDocSpeakers(docId, fetchImpl))?.voices ?? [];
}

/**
 * Name a voice on a meeting that already ended — the strip's fallback once
 * the audio socket (the live rename channel) is gone. True when the server
 * recorded it; false is a refusal the caller must surface, because a name
 * that only ever lands on the screen reads as saved.
 */
export async function postSpeakerName(
  args: { docId: string; meetingId: string; speaker: string; name: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const res = await fetchImpl(
    api(
      `docs/${encodeURIComponent(args.docId)}/meetings/${encodeURIComponent(args.meetingId)}/speakers`,
    ),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ speaker: args.speaker, name: args.name }),
    },
  );
  return res.ok;
}
