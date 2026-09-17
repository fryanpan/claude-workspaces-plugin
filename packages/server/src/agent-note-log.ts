/**
 * The durable half of the agent note ring: every note this board could not
 * put on a row.
 *
 * WHY IT EXISTS. `resolveNoteTarget` answers with a row only when the agent
 * holds exactly one in-progress claim on the board, and refusing to guess is
 * right — a judged sample put the old newest-claim guess wrong about three
 * times in four. But the note it refuses to place then went to
 * `AgentNoteRing` alone: in-process, twenty per agent, gone on restart, and
 * read by nothing. So on a board where one session holds many rows, EVERY
 * end-of-turn message was written to a buffer nobody reads and then dropped.
 * Measured on this fleet: one board logged 494 turn notes up to 2026-09-02
 * and none in the fifteen days after, while 1,793 status notes kept arriving,
 * because `post_status` names its row and the Stop hook cannot.
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
import type { AgentNoteKind } from './agent-notes.ts';
import { normalizeAgent } from './chat-audit.ts';

/** How many of a board's trailing lines a read parses. A note is at most
 *  `NOTE_TEXT_MAX` (4000) chars, so this is a few hundred KB in the worst
 *  case and a single-digit KB in the normal one. */
const READ_LINES_CAP = 500;
/** How many bytes are read off the tail to find those lines. Sized for the
 *  worst case above with headroom; a file under it is read whole. */
const READ_BYTES_CAP = 4 * 1024 * 1024;
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
  if (typeof r.kind !== 'string') return undefined;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return undefined;
  if (typeof r.workspaceId !== 'string' || r.workspaceId === '') return undefined;
  return {
    agent: r.agent,
    kind: r.kind as AgentNoteKind,
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
  constructor(private readonly dataDir: string) {}

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
   */
  readFor(workspaceId: string, agent: string, cap = LOG_READ_CAP): LoggedAgentNote[] {
    const who = normalizeAgent(agent);
    const out: LoggedAgentNote[] = [];
    for (const note of this.tail(workspaceId)) {
      if (normalizeAgent(note.agent) !== who) continue;
      out.push(note);
    }
    return out.reverse().slice(0, Math.max(0, cap));
  }

  /**
   * When this agent's previous TURN note was logged on this board.
   *
   * The unfiled-ask judgement measures "filed nothing this turn" from the
   * previous turn note's time, and read that off the in-process ring alone —
   * so a restarted server fell back to a two-hour window and could nudge for
   * an ask filed inside it. The log answers across a restart.
   */
  lastTurnAt(workspaceId: string, agent: string): number | undefined {
    const who = normalizeAgent(agent);
    let latest: number | undefined;
    for (const note of this.tail(workspaceId)) {
      if (note.kind !== 'turn') continue;
      if (normalizeAgent(note.agent) !== who) continue;
      if (latest === undefined || note.at > latest) latest = note.at;
    }
    return latest;
  }

  /** The board's trailing lines, oldest first, parsed and bounded. A torn
   *  first line (the tail read cut it mid-JSON) drops out of `parseLine` the
   *  same way a torn last line does, so no caller has to know. */
  private tail(workspaceId: string): LoggedAgentNote[] {
    const path = agentNoteLogPath(this.dataDir, workspaceId);
    let text: string;
    try {
      if (!existsSync(path)) return [];
      const size = statSync(path).size;
      if (size <= READ_BYTES_CAP) {
        text = readFileSync(path, 'utf8');
      } else {
        // Seek, do not read the whole file and slice it — the point of the
        // cap is that a months-old log costs a fixed read.
        const buf = Buffer.alloc(READ_BYTES_CAP);
        const fd = openSync(path, 'r');
        try {
          readSync(fd, buf, 0, READ_BYTES_CAP, size - READ_BYTES_CAP);
        } finally {
          closeSync(fd);
        }
        text = buf.toString('utf8');
      }
    } catch (err) {
      console.error(`[agent-notes] failed to read the unplaced-note log: ${String(err)}`);
      return [];
    }
    const lines = text.split('\n');
    const from = Math.max(0, lines.length - READ_LINES_CAP);
    const out: LoggedAgentNote[] = [];
    for (let i = from; i < lines.length; i++) {
      const parsed = parseLine(lines[i] ?? '');
      if (parsed) out.push(parsed);
    }
    return out;
  }
}
