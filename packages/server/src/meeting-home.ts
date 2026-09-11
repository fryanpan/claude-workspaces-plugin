/**
 * Where a meeting lives: the project it belongs to, the folder its words are
 * written into, and how much of it that project chose to keep.
 *
 * A meeting used to belong to nothing. "Make a plan" and "have a meeting"
 * both minted a doc whose markdown went to `<dataDir>/huddles/<docId>.md` —
 * outside every checkout, unreachable by grep, invisible to the project it
 * was about. Rule 5 of the docs decision says the opposite: a huddle or
 * transcript with no ticket lands in a mounted folder under the project,
 * marked as a meeting with its kind and its provider, and the project — never
 * this server — decides whether transcripts and audio are kept at all.
 *
 * So this module holds two things and no more.
 *
 * **The project's choice**, as a value the mount registry stores beside the
 * privacy and conventions settings it already keeps per project: which folder
 * meetings file into, what is kept, and whether that folder is gitignored.
 * The parsing and the defaults are here because the default IS a decision —
 * `transcripts-and-audio` is today's behaviour, so a project that has never
 * been asked keeps exactly what it kept yesterday.
 *
 * **The filing record**: one append-only line per meeting saying which board
 * it was started on, which project and lead agent it belongs to, what kind of
 * meeting it was and which provider heard it. Append-only and folded on read,
 * the shape `meetings.jsonl` uses next door and for the same reason: a
 * meeting learns some of these an hour after it learns the others, and a
 * record that is rewritten is a record a crash can tear.
 *
 * Nothing here deletes. Retention is expressed as what is never WRITTEN — see
 * `meetingRetentionKeeps` — because soft delete is project-wide and a
 * transcript is the least reconstructible thing this server holds. A project
 * that does not want the words gets a meeting that never wrote them, not a
 * meeting whose words were taken away afterwards.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// What a project chose to keep
// ---------------------------------------------------------------------------

/**
 * How much of a meeting this project keeps on disk.
 *
 * `transcripts-and-audio` is everything the server writes today: the settled
 * turns, the readable companion beside them, and the raw PCM the words were
 * heard from. `transcripts` keeps the words and never opens an audio sink —
 * audio is the half that grows without bound. `none` keeps neither: the
 * meeting still runs, the notes still compose into the doc, and the index
 * still says a meeting was held and for how long, because that is metadata
 * about the meeting rather than a record of what was said in it.
 */
export type MeetingRetention = 'transcripts-and-audio' | 'transcripts' | 'none';

/** Every value, for parsing and for a refusal that can name the alternatives. */
export const MEETING_RETENTIONS: readonly MeetingRetention[] = [
  'transcripts-and-audio',
  'transcripts',
  'none',
];

/**
 * Today's behaviour, and therefore the default.
 *
 * A project that has never set this must not have its recordings change under
 * it, so the absent value is the permissive one. That is the opposite of the
 * privacy default's reasoning next door — there, an unrecognised value reads
 * as the restrictive one — and the difference is deliberate: privacy is about
 * what may LEAVE, where guessing open is the dangerous direction; retention is
 * about what is written at all, where guessing "keep nothing" silently
 * destroys a record nobody asked to lose.
 */
export const DEFAULT_MEETING_RETENTION: MeetingRetention = 'transcripts-and-audio';

/** A stored or caller-supplied value, or null when it is none of them. */
export function parseMeetingRetention(raw: unknown): MeetingRetention | null {
  return (MEETING_RETENTIONS as readonly string[]).includes(raw as string)
    ? (raw as MeetingRetention)
    : null;
}

/** Does this retention keep a meeting's words? Its audio? */
export function meetingRetentionKeeps(
  retention: MeetingRetention,
  what: 'transcript' | 'audio',
): boolean {
  if (retention === 'none') return false;
  return what === 'transcript' || retention === 'transcripts-and-audio';
}

/** What a project decided about its meetings. */
export interface MeetingHomeChoice {
  /** POSIX, relative to the repo root — the folder meetings file into. */
  relPath: string;
  retention: MeetingRetention;
  /** Whether this server keeps a `.gitignore` inside that folder. */
  gitignore: boolean;
}

// ---------------------------------------------------------------------------
// The folder's .gitignore, when the project asked for one
// ---------------------------------------------------------------------------

/**
 * The whole file this server writes, byte for byte.
 *
 * Fixed text so the removal side can recognise its OWN file and refuse to
 * touch anybody else's: a project that hand-wrote a `.gitignore` in its
 * meetings folder has said something this server was not told, and
 * "workspaces applies the choice" does not extend to deleting a file somebody
 * else authored.
 */
export const MEETING_GITIGNORE_BODY =
  '# Written by claude-workspaces because this project chose to keep its\n' +
  '# meetings out of git. Delete this file to commit them instead.\n' +
  '*\n';

/** Where that file sits. */
export function meetingGitignorePath(folderAbs: string): string {
  return join(folderAbs, '.gitignore');
}

/**
 * Apply the project's gitignore choice to its meetings folder.
 *
 * `written` / `removed` say the file moved; `kept` and `absent` say it was
 * already as asked. `foreign` is the one case that does nothing and says so:
 * the file exists, the project asked for no gitignore, and the bytes are not
 * ours — so the choice is reported rather than enforced over somebody's
 * hand-written rules.
 */
export function applyMeetingGitignore(
  folderAbs: string,
  gitignore: boolean,
): 'written' | 'kept' | 'removed' | 'absent' | 'foreign' {
  const path = meetingGitignorePath(folderAbs);
  const present = existsSync(path);
  const ours = present && readFileSync(path, 'utf8') === MEETING_GITIGNORE_BODY;
  if (gitignore) {
    if (ours) return 'kept';
    // A foreign file is left exactly where it is: it may ignore MORE than
    // ours does, and overwriting it would be this server deciding what the
    // project commits, which is the one thing rule 1 forbids.
    if (present) return 'foreign';
    mkdirSync(folderAbs, { recursive: true });
    writeFileSync(path, MEETING_GITIGNORE_BODY);
    return 'written';
  }
  if (!present) return 'absent';
  if (!ours) return 'foreign';
  rmSync(path);
  return 'removed';
}

// ---------------------------------------------------------------------------
// The filing record
// ---------------------------------------------------------------------------

/** Which entry flow opened this meeting. */
export type MeetingKind = 'plan' | 'discussion' | 'calendar';

/**
 * One meeting, as the filing index describes it after folding its lines.
 *
 * Every field but `docId` and `filedAt` can be absent, because a meeting can
 * be started on a board with no project, before a lead has taken the seat, or
 * with nothing yet heard — and an absent field is an honest "nobody said",
 * where a placeholder would be a claim.
 */
export interface MeetingFiling {
  docId: string;
  /** The board the meeting was started on. */
  workspaceId: string;
  filedAt: number;
  /** The project it belongs to, as `repoKey`, or absent when the board has none. */
  repoKey?: string;
  /** The lead agent seated on that board when the meeting opened. */
  leadAgentId?: string;
  kind: MeetingKind;
  /**
   * Who heard it. The transcription engine for a meeting this server records
   * (`assemblyai`, `soniox`), the bot vendor for one a bot attends, and
   * `none` for a meeting nobody transcribed — a plan written by hand is still
   * a meeting, and saying so is the point of recording the field at all.
   */
  provider: string;
  /** Where its markdown landed, repo-relative when it went into the project. */
  relPath?: string;
  /** What the project kept, as it stood when the meeting was filed. */
  retention: MeetingRetention;
}

/** Where the filing index lives. One file for the whole server, as the
 *  question it answers ("which meetings are there") is never per-doc. */
export function meetingFilingIndexPath(dataDir: string): string {
  return join(dataDir, 'meetings', 'filings.jsonl');
}

/** Append one line. Every write here is a whole record; nothing is patched. */
export function recordMeetingFiling(dataDir: string, filing: MeetingFiling): void {
  const path = meetingFilingIndexPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(filing)}\n`);
}

/**
 * Every meeting filed, oldest first, last line per doc winning.
 *
 * A torn tail line is skipped rather than thrown on, the rule the transcript
 * and the event log already hold: one bad append must not take the index down.
 */
export function listMeetingFilings(dataDir: string): MeetingFiling[] {
  const path = meetingFilingIndexPath(dataDir);
  if (!existsSync(path)) return [];
  const byDoc = new Map<string, MeetingFiling>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const docId = typeof row.docId === 'string' ? row.docId : null;
    const workspaceId = typeof row.workspaceId === 'string' ? row.workspaceId : null;
    if (!docId || !workspaceId) continue;
    const kind = row.kind;
    byDoc.set(docId, {
      docId,
      workspaceId,
      filedAt: typeof row.filedAt === 'number' ? row.filedAt : 0,
      ...(typeof row.repoKey === 'string' ? { repoKey: row.repoKey } : {}),
      ...(typeof row.leadAgentId === 'string' ? { leadAgentId: row.leadAgentId } : {}),
      kind: kind === 'plan' || kind === 'discussion' || kind === 'calendar' ? kind : 'discussion',
      provider: typeof row.provider === 'string' ? row.provider : 'none',
      ...(typeof row.relPath === 'string' ? { relPath: row.relPath } : {}),
      retention: parseMeetingRetention(row.retention) ?? DEFAULT_MEETING_RETENTION,
    });
  }
  return [...byDoc.values()].sort((a, b) => a.filedAt - b.filedAt);
}

/** One meeting's filing, or undefined when this doc is not a filed meeting. */
export function meetingFilingFor(dataDir: string, docId: string): MeetingFiling | undefined {
  return listMeetingFilings(dataDir).find((f) => f.docId === docId);
}

/**
 * Say who heard this meeting, once something does.
 *
 * A meeting is filed the moment it is opened, before anybody has spoken, so
 * its provider starts as `none`. Left there it would be a lie by omission: a
 * meeting transcribed by an engine would read in this index exactly like one
 * nobody listened to, and telling those apart is the entire reason the field
 * exists. So the first recording on the doc appends a fresh line naming the
 * engine, and the fold's last-line-wins rule does the rest — no rewrite, the
 * same shape every other record here uses.
 *
 * Only for a doc already filed as a meeting. A recording started on an
 * ordinary project doc has no board, no project and no kind to claim, and
 * inventing a filing for it would put a document in the meetings index that
 * nobody ever called a meeting.
 */
export function noteMeetingProvider(dataDir: string, docId: string, provider: string): void {
  const filed = meetingFilingFor(dataDir, docId);
  if (!filed || filed.provider === provider) return;
  recordMeetingFiling(dataDir, { ...filed, provider });
}

/**
 * The file name a meeting's markdown takes inside the project's folder.
 *
 * The doc's ALIAS, which is already `huddle-20260829-1405-x7q2` — readable,
 * sorted by when it happened, and unique by construction. The doc id would
 * work too and reads as noise in a directory listing somebody greps.
 */
export function meetingFileName(alias: string): string {
  return `${alias.replace(/[^A-Za-z0-9._-]/g, '_')}.md`;
}
