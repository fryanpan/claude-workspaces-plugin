/**
 * The durable half of the agent note ring: every note this board could not
 * put on a row.
 *
 * WHY IT EXISTS. `resolveNoteTarget` answers with a row only when the agent
 * holds exactly one in-progress claim on the board, and refusing to guess is
 * right — a judged sample put the old newest-claim guess wrong about three
 * times in four. But the note it refuses to place then went to
 * `AgentNoteRing` alone: in-process, twenty per agent, gone on restart, and
 * read by nothing. So whenever a session holds more than one such row, EVERY
 * end-of-turn message was written to a buffer nobody reads and then dropped.
 *
 * WHAT TRIGGERS IT, precisely, because the loose version of this sentence is
 * wrong and was believed for a while. Not "the board is busy": the walk keeps
 * the in-progress rows that are THIS AGENT'S and refuses only if it kept more
 * than one. A row is the agent's when the actor of its latest in-progress
 * transition is that agent, or — when a PERSON moved it, so the claimant says
 * nothing — when the stored assignee folds to its name. A lead and three
 * builders each holding one row place every note they write; one agent
 * holding two rows places none. A count of a board's rows cannot tell the two
 * apart, and `turn-note-many-rows.test.ts` drives both.
 *
 * `post_status` is unaffected throughout, because it names its row and takes
 * the explicit-address branch; the Stop hook has no row to name.
 *
 * WHAT IT DOES NOT DO. It does not pick a row. An unplaced note stays
 * unplaced; this only makes it survive. The row it belongs to is a question
 * for whoever reads it, and a durable record is what lets that question be
 * asked at all.
 *
 * WHY A SIDECAR AND NOT `events.jsonl`. A store event is the board's audit
 * trail, and every consumer of that trail — board activity, the presence
 * strip, the stall wiring, the workspace stream — carries its own exclusion
 * list that `task.noted` already had to be added to. A new event type is a
 * new row in four exclusion lists and a silent wake for every attached agent
 * if one is missed. An unplaced note is not a change to the board; it is a
 * record about an agent. So it gets its own file, next to the board's other
 * per-workspace files.
 *
 * SHAPE. Append-only JSONL, one file per board, one line per note, nothing
 * already written ever touched again — the same rule and the same torn-tail
 * tolerance as `events.jsonl` and the meeting transcripts. Nothing here
 * deletes: soft delete is project-wide, and reads are bounded from the tail
 * instead.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { type AgentNoteKind, isAgentNoteKind } from './agent-notes.ts';
import { normalizeAgent } from './chat-audit.ts';

/** How many lines one read will `JSON.parse` before it stops looking. It
 *  bounds the WORK, not the reach: the walk filters as it goes, so this is
 *  reached only by an agent whose notes are all older than this many lines of
 *  other agents'. The byte cap alone would not bound it — four megabytes of
 *  short lines is twenty thousand parses on a route that answers a hook. */
const PARSE_LINES_CAP = 5000;
/** How many bytes off the tail a read may look at. The other bound, and the
 *  one that decides REACH: a note is at most `NOTE_TEXT_MAX` (4000) chars, so
 *  this holds a thousand of the largest notes a board can write and far more
 *  real ones. A file under it is read whole. Overridable per instance so a
 *  test can drive the seek branch without writing four megabytes — that
 *  branch is the one that cannot be reasoned about by reading it. */
export const READ_BYTES_CAP = 4 * 1024 * 1024;
/** How many notes one `readFor` hands back, newest first. Matches the ring's
 *  own per-agent cap so the two reads agree on length. */
export const LOG_READ_CAP = 20;

/** One line of the log. The wire shape of a note plus where it was headed. */
export interface LoggedAgentNote {
  agent: string;
  kind: AgentNoteKind;
  text: string;
  at: number;
  workspaceId: string;
  sessionId?: string;
  /** True when the note faced 2+ candidate rows. False when it faced none —
   *  both are unplaced, and the distinction is why, not whether. */
  ambiguous: boolean;
}

/** The path a board's unplaced notes are written to. Beside `events.jsonl`,
 *  which is the file this one is a sibling of rather than a part of. */
export function agentNoteLogPath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.agent-notes.jsonl`);
}

/** A parsed line, or undefined when the line is torn, truncated or foreign. */
function parseLine(line: string): LoggedAgentNote | undefined {
  if (line.trim() === '') return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.agent !== 'string' || r.agent === '') return undefined;
  if (typeof r.text !== 'string' || r.text === '') return undefined;
  // The route's own list, not a re-spelling of it: a line carrying a kind
  // this build does not know is foreign, and `kind` is read by callers that
  // switch on it. A cast here would have let one through as a valid value.
  if (!isAgentNoteKind(r.kind)) return undefined;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return undefined;
  if (typeof r.workspaceId !== 'string' || r.workspaceId === '') return undefined;
  return {
    agent: r.agent,
    kind: r.kind,
    text: r.text,
    at: r.at,
    workspaceId: r.workspaceId,
    ambiguous: r.ambiguous === true,
    ...(typeof r.sessionId === 'string' ? { sessionId: r.sessionId } : {}),
  };
}

/**
 * Per-board, append-only storage for notes no row would take.
 *
 * One instance per server, holding only the data directory: a board is named
 * on every call, so nothing here has to be told which boards exist, and
 * nothing here enumerates them. Enumerating a server's boards is how a sweep
 * once hydrated every dormant doc on this machine.
 */
export class AgentNoteLog {
  private readonly bytesCap: number;

  private readonly parseLinesCap: number;

  /** Both caps are overridable per instance so a test can reach the bound it
   *  is checking without writing four megabytes or five thousand lines. They
   *  are the two bounds on a read, and neither is reachable from the other. */
  constructor(
    private readonly dataDir: string,
    bytesCap: number = READ_BYTES_CAP,
    parseLinesCap: number = PARSE_LINES_CAP,
  ) {
    this.bytesCap = Math.max(1, bytesCap);
    this.parseLinesCap = Math.max(1, parseLinesCap);
  }

  /**
   * Record one unplaced note.
   *
   * Returns whether the line was written. It CANNOT throw: this runs inside a
   * route that answered 202 before durability was part of its contract, and
   * a full disk or a read-only volume must cost the record, not the response.
   * The failure is logged once per occurrence rather than swallowed, because
   * a board silently keeping no record is the exact defect this file exists
   * to end.
   */
  append(note: LoggedAgentNote): boolean {
    try {
      const dir = join(this.dataDir, 'workspaces');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(agentNoteLogPath(this.dataDir, note.workspaceId), `${JSON.stringify(note)}\n`);
      return true;
    } catch (err) {
      console.error(`[agent-notes] failed to log an unplaced note: ${String(err)}`);
      return false;
    }
  }

  /**
   * This agent's unplaced notes on this board, newest first, at most `cap`.
   *
   * Read from the tail: a board that has run for months must not cost a whole
   * file parse to answer "what did this agent say lately". A missing file is
   * an empty list, not an error — a board with nothing unplaced is the state
   * this whole change is trying to reach.
   *
   * Newest by `at`, not by position in the file. The two agree whenever one
   * server appended the whole file and diverge whenever a restart, a clock
   * adjustment or a hook's own timestamp got in between — and `at` is what
   * every caller and every reader means by "latest".
   */
  readFor(workspaceId: string, agent: string, cap = LOG_READ_CAP): LoggedAgentNote[] {
    const who = normalizeAgent(agent);
    const want = Math.max(0, cap);
    const found = this.tailMatching(workspaceId, (n) => normalizeAgent(n.agent) === who, want);
    return found.sort((a, b) => b.at - a.at);
  }

  /**
   * When this agent's previous TURN note was logged on this board.
   *
   * The unfiled-ask judgement measures "filed nothing this turn" from the
   * previous turn note's time, and read that off the in-process ring alone —
   * so a restarted server fell back to a two-hour window and could nudge for
   * an ask filed inside it. The log answers across a restart.
   *
   * The greatest `at` among the last `LOG_READ_CAP` matches, not the first
   * match the backwards walk meets. File order is append order, and the two
   * differ exactly when a clock moved — which is one of the cases this read
   * exists to survive.
   */
  lastTurnAt(workspaceId: string, agent: string): number | undefined {
    const who = normalizeAgent(agent);
    const found = this.tailMatching(
      workspaceId,
      (n) => n.kind === 'turn' && normalizeAgent(n.agent) === who,
      LOG_READ_CAP,
    );
    let latest: number | undefined;
    for (const note of found) {
      if (latest === undefined || note.at > latest) latest = note.at;
    }
    return latest;
  }

  /**
   * Walk the board's trailing lines backwards, keep what `keep` wants, stop
   * at `want` matches.
   *
   * FILTER INSIDE THE WALK; never cut a prefix and filter after. The earlier
   * version parsed the file's last 500 lines and then filtered, which reads
   * fine and is wrong on exactly the board this file was written for: a
   * many-row board is a busy one, so a quiet agent's notes sit behind
   * hundreds of a chatty agent's and fall out of the window before the filter
   * sees them. The cut has to be per agent or it is not a cut at all.
   *
   * Two bounds, because they fail differently. `bytesCap` bounds the READ, so
   * a months-old file costs a fixed number of bytes. `PARSE_LINES_CAP` bounds
   * the WORK. Hitting either returns fewer matches than asked for rather than
   * an error: this is a best-effort read of a best-effort record, and a hook
   * waiting on it must not wait longer to be told less.
   *
   * A torn first line (the byte read cut it mid-JSON) drops out of
   * `parseLine` the same way a torn last one does, so no caller has to know.
   */
  private tailMatching(
    workspaceId: string,
    keep: (note: LoggedAgentNote) => boolean,
    want: number,
  ): LoggedAgentNote[] {
    const out: LoggedAgentNote[] = [];
    if (want <= 0) return out;
    const lines = this.tailText(workspaceId).split('\n');
    let parsed = 0;
    for (let i = lines.length - 1; i >= 0 && out.length < want; i--) {
      const line = lines[i] ?? '';
      if (line === '') continue;
      if (parsed >= this.parseLinesCap) break;
      parsed++;
      const note = parseLine(line);
      if (note && keep(note)) out.push(note);
    }
    return out;
  }

  /** The tail bytes of the board's log, decoded. Empty when the file is
   *  missing or the read failed — both are "nothing to say", and neither is
   *  worth an exception on a hook's path. */
  private tailText(workspaceId: string): string {
    const path = agentNoteLogPath(this.dataDir, workspaceId);
    try {
      if (!existsSync(path)) return '';
      const size = statSync(path).size;
      if (size <= this.bytesCap) {
        return readFileSync(path, 'utf8');
      }
      // Seek, do not read the whole file and slice it — the point of the
      // cap is that a months-old log costs a fixed read.
      //
      // Decoded only as far as `readSync` actually filled, because decoding
      // the whole buffer would append the allocation's zero bytes to the
      // LAST line — turning the newest note into invalid JSON and dropping
      // exactly the one a caller came for. DEFENSIVE AND UNTESTED: a local
      // append-only file never shrinks, so a full-length read off a
      // known-good offset does not come back short here, and a mutation
      // control that ignored `read` passed every case in
      // `agent-note-log.test.ts`. Kept because the failure it guards is
      // silent and the guard is one argument.
      const buf = Buffer.alloc(this.bytesCap);
      const fd = openSync(path, 'r');
      let read = 0;
      try {
        read = readSync(fd, buf, 0, this.bytesCap, size - this.bytesCap);
      } finally {
        closeSync(fd);
      }
      // The seek lands mid-character as readily as mid-line; the partial
      // first line is dropped by `parseLine` either way.
      return buf.toString('utf8', 0, read);
    } catch (err) {
      console.error(`[agent-notes] failed to read the unplaced-note log: ${String(err)}`);
      return '';
    }
  }
}
