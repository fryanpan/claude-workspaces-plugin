import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Chat-audit counters: the per-agent "unfiled asks" numbers the daily chat
 * audit publishes, stored so a session can read its own back.
 *
 * THE SERVER DOES SEE ONE LINE OF CHAT, and this file used to say it did
 * not. The claim was that chat happens in each session's terminal, so only a
 * daily transcript-mining audit could judge "an ask appeared in chat with no
 * review item behind it", and the audit was therefore the single writer. The
 * first half was never true: the plugin's Stop hook has been posting every
 * session's CLOSING MESSAGE to this server since agent notes shipped, and the
 * closing message is where the asks are. The second half stopped being true
 * the moment that was noticed — `POST /workspaces/{id}/agents/{name}/notes`
 * now judges each turn note as it arrives (`unfiled-ask.ts`) and records the
 * verdict here.
 *
 * So there are TWO writers, distinguished by the `auditor` on each row:
 *  - `LIVE_AUDITOR` — this server, one row per detected ask, in real time.
 *    It sees only the closing message, which is a fraction of the turn's
 *    chat, and it judges with a regex whose measured error rates are in
 *    `docs/architecture/unfiled-ask.md`. It is a floor, not a census.
 *  - a named agent — the daily transcript audit, which reads the whole
 *    transcript and can see what the closing message left out. It has not
 *    run since 2026-08-27; when it does, its row for a day supersedes the
 *    live one, because it looked at more.
 *
 * The read a session gets back is still whatever row is latest for it, which
 * is the honest answer to "what does this board currently believe about me".
 *
 * Storage is append-only JSONL at `<dataDir>/chat-audit.jsonl`, one row per
 * (publish, agent). Corrections are new rows and the latest row per agent
 * wins on read — nothing is ever rewritten or pruned, per the project-wide
 * soft-delete rule (the log is a durable record, like activity.jsonl).
 *
 * Agents are keyed by their display name (CW_AGENT_NAME — e.g. "Live
 * Feedback"), normalized case/whitespace-insensitively, because that is the
 * one identity the audit (reading transcripts) and the MCP session (reading
 * its own env) both hold.
 */

/** The `auditor` this server stamps on the rows it writes itself. A reader
 *  telling the two apart needs no other field. */
export const LIVE_AUDITOR = 'stop-hook';

export interface ChatAuditEntryInput {
  /** Display name the audit knows the session by (CW_AGENT_NAME). */
  agent: string;
  /** Asks that appeared in chat without a matching filed review item. */
  unfiledAsks: number;
  /** Total asks the audit saw in chat, filed or not (optional context). */
  totalAsks?: number;
  /** Claude Code session uuid, when the audit attributes to one session. */
  sessionId?: string;
  /** Evidence pointer in the auditor's words (thread URL, timestamps). */
  note?: string;
  /** The board the ask was seen on, for a live row. Absent on a daily-audit
   *  row, which mines a session's whole transcript and knows no board.
   *
   *  Recorded, and deliberately NOT filtered on by `window`. The question the
   *  count answers is "how many asks reached the OWNER as chat", and the
   *  owner is one person across every board he keeps; a per-board window
   *  would also read zero for every row the daily audit ever published,
   *  because those carry no board at all. The field is here so a later
   *  surface that genuinely is about one board can filter, without a
   *  migration. */
  workspaceId?: string;
}

export interface ChatAuditRow extends ChatAuditEntryInput {
  /** ISO-8601 UTC with trailing Z — when the audit published this row. */
  ts: string;
  /** The day the audit is reporting on, YYYY-MM-DD. */
  day: string;
  /** Who published (the auditing agent's display name). */
  auditor?: string;
}

export interface ChatAuditPublishInput {
  day?: string;
  auditor?: string;
  entries: ChatAuditEntryInput[];
}

/** Case/whitespace-insensitive agent-name key. */
export function normalizeAgent(name: string): string {
  return name.trim().toLowerCase();
}

/** Shared identities no per-agent count can be filed under — a count for the
 *  bare category "agent" answers nothing about anybody. */
const SHARED_NAMES = new Set(['agent', 'known-agent']);

export function isSharedAgentName(name: string): boolean {
  return SHARED_NAMES.has(normalizeAgent(name));
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 2000;

/** One agent's totals over a window — see `ChatAudit.window`. */
export interface ChatAuditWindowRow {
  agent: string;
  unfiledAsks: number;
  totalAsks: number;
  /** How many days of the window the agent has any row on. A count over one
   *  day and a count over seven are not the same number, and the surface
   *  showing them has to be able to say which it is. */
  days: number;
}

/** `n` days before `day`, as YYYY-MM-DD. */
export function dayBefore(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) - n * 86_400_000;
  const back = new Date(t);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${back.getUTCFullYear()}-${pad(back.getUTCMonth() + 1)}-${pad(back.getUTCDate())}`;
}

/** Absolute path of the chat-audit log inside a data dir. */
export function chatAuditLogPath(dataDir: string): string {
  return join(dataDir, 'chat-audit.jsonl');
}

/** The server's current day as YYYY-MM-DD in ITS OWN local timezone — the
 *  audit, the sessions, and this server all run on the same machine, and the
 *  audit's "day" is that machine's calendar day, not UTC's. */
export function localDay(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class ChatAudit {
  private readonly path: string;
  private readonly now: () => number;
  private rows: ChatAuditRow[] = [];
  /** Non-null when loading found lines it could not parse. The good lines
   *  still loaded — a corrupt tail must not blank the whole history. */
  loadError: string | null = null;

  constructor(opts: { dataDir: string; now?: () => number }) {
    this.path = chatAuditLogPath(opts.dataDir);
    this.now = opts.now ?? Date.now;
    this.load(opts.dataDir);
  }

  private load(dataDir: string): void {
    if (!existsSync(this.path)) return;
    let skipped = 0;
    try {
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as ChatAuditRow;
          if (typeof row.agent === 'string' && typeof row.unfiledAsks === 'number') {
            this.rows.push(row);
          } else {
            skipped++;
          }
        } catch {
          skipped++;
        }
      }
    } catch (err) {
      this.loadError = `failed to read ${this.path}: ${String(err)}`;
      return;
    }
    if (skipped > 0) {
      this.loadError = `skipped ${skipped} unparseable line(s) in ${chatAuditLogPath(dataDir)}`;
    }
  }

  /**
   * Validate and append one publish (throws on invalid input, writing
   * nothing — a partial publish would leave the audit half-recorded).
   */
  publish(input: ChatAuditPublishInput): { rows: ChatAuditRow[] } {
    const entries = Array.isArray(input.entries) ? input.entries : [];
    if (entries.length === 0) throw new Error('entries must be a non-empty array');
    if (input.day !== undefined && !DAY_RE.test(input.day)) {
      throw new Error('day must be YYYY-MM-DD');
    }
    const nowMs = this.now();
    const ts = new Date(nowMs).toISOString();
    const day = input.day ?? localDay(nowMs);
    const auditor = typeof input.auditor === 'string' ? input.auditor.trim() : undefined;

    const stamped: ChatAuditRow[] = entries.map((e) => {
      const agent = typeof e.agent === 'string' ? e.agent.trim() : '';
      if (!agent) throw new Error('entry.agent must be a non-empty string');
      if (isSharedAgentName(agent)) {
        throw new Error(
          `"${agent}" is a shared identity, not somebody — publish counts under the agent's display name (CW_AGENT_NAME)`,
        );
      }
      if (!Number.isInteger(e.unfiledAsks) || e.unfiledAsks < 0) {
        throw new Error('entry.unfiledAsks must be a non-negative integer');
      }
      if (e.totalAsks !== undefined && (!Number.isInteger(e.totalAsks) || e.totalAsks < 0)) {
        throw new Error('entry.totalAsks must be a non-negative integer');
      }
      return {
        ts,
        day,
        ...(auditor ? { auditor } : {}),
        agent,
        unfiledAsks: e.unfiledAsks,
        ...(e.totalAsks !== undefined ? { totalAsks: e.totalAsks } : {}),
        ...(typeof e.sessionId === 'string' && e.sessionId ? { sessionId: e.sessionId } : {}),
        ...(typeof e.note === 'string' && e.note ? { note: e.note.slice(0, NOTE_MAX) } : {}),
      };
    });

    // All rows validated before any byte lands — append is all-or-nothing.
    const dir = join(this.path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.path, `${stamped.map((r) => JSON.stringify(r)).join('\n')}\n`);
    this.rows.push(...stamped);
    return { rows: stamped };
  }

  /** Latest row per agent (file order breaks ts ties — later line wins). */
  latestPerAgent(): ChatAuditRow[] {
    const byAgent = new Map<string, ChatAuditRow>();
    for (const row of this.rows) {
      const key = normalizeAgent(row.agent);
      const prev = byAgent.get(key);
      if (!prev || row.ts >= prev.ts) byAgent.set(key, row);
    }
    return [...byAgent.values()];
  }

  /**
   * One live detection, from the Stop hook's turn note.
   *
   * The day's running totals for that agent are carried forward from the
   * latest row this store already holds for (agent, day) — the file is the
   * state, so a restart continues the day's count rather than restarting it,
   * and a day the daily audit has already published for continues from the
   * audit's numbers rather than from zero.
   *
   * Nothing is written when no ask was seen: a row per turn would be ~100
   * lines a day of "still zero", and the denominator that matters for
   * reading these numbers is the measured error rate, not the turn count.
   */
  recordLive(input: {
    agent: string;
    unfiled: boolean;
    note?: string;
    sessionId?: string;
    workspaceId?: string;
  }): ChatAuditRow | null {
    const agent = input.agent.trim();
    if (!agent || isSharedAgentName(agent)) return null;
    const nowMs = this.now();
    const day = localDay(nowMs);
    let prior: ChatAuditRow | undefined;
    for (const r of this.rows) {
      if (normalizeAgent(r.agent) === normalizeAgent(agent) && r.day === day) prior = r;
    }
    const row: ChatAuditRow = {
      ts: new Date(nowMs).toISOString(),
      day,
      auditor: LIVE_AUDITOR,
      agent,
      unfiledAsks: (prior?.unfiledAsks ?? 0) + (input.unfiled ? 1 : 0),
      totalAsks: (prior?.totalAsks ?? 0) + 1,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.note ? { note: input.note.slice(0, NOTE_MAX) } : {}),
    };
    const dir = join(this.path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(row)}\n`);
    this.rows.push(row);
    return row;
  }

  /**
   * Per-agent totals over the last `days` calendar days, newest day first —
   * what a surface showing "how many asks reached the owner as chat this
   * week" reads. One entry per agent, summed across the days it appears on,
   * taking the LATEST row per (agent, day) because rows within a day carry
   * running totals rather than increments.
   */
  window(
    days: number,
    today: string,
  ): { days: number; from: string; agents: ChatAuditWindowRow[] } {
    const from = dayBefore(today, Math.max(1, days) - 1);
    const latest = new Map<string, ChatAuditRow>();
    for (const row of this.rows) {
      if (row.day < from || row.day > today) continue;
      const key = `${normalizeAgent(row.agent)}\u0000${row.day}`;
      const prev = latest.get(key);
      if (!prev || row.ts >= prev.ts) latest.set(key, row);
    }
    const byAgent = new Map<string, ChatAuditWindowRow>();
    for (const row of latest.values()) {
      const key = normalizeAgent(row.agent);
      const acc = byAgent.get(key) ?? { agent: row.agent, unfiledAsks: 0, totalAsks: 0, days: 0 };
      acc.unfiledAsks += row.unfiledAsks;
      acc.totalAsks += row.totalAsks ?? row.unfiledAsks;
      acc.days += 1;
      byAgent.set(key, acc);
    }
    const agents = [...byAgent.values()].sort((a, b) => b.unfiledAsks - a.unfiledAsks);
    return { days: Math.max(1, days), from, agents };
  }

  /**
   * What one agent reads about itself: its latest published row, and the
   * latest row whose audited day is `today` (null when no audit has covered
   * today yet — a real answer, not a failure).
   */
  readFor(
    agent: string,
    today: string,
  ): { today: ChatAuditRow | null; latest: ChatAuditRow | null } {
    const key = normalizeAgent(agent);
    let latest: ChatAuditRow | null = null;
    let todayRow: ChatAuditRow | null = null;
    for (const row of this.rows) {
      if (normalizeAgent(row.agent) !== key) continue;
      if (!latest || row.ts >= latest.ts) latest = row;
      if (row.day === today && (!todayRow || row.ts >= todayRow.ts)) todayRow = row;
    }
    return { today: todayRow, latest };
  }
}
