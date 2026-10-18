/**
 * The owner's time in Claude Code sessions, as the coach's digest counts it.
 *
 * The digest saw only board pages, and most of his lower-priority time goes
 * in terminals. Every attached session posts a mark for each prompt (the
 * plugin's UserPromptSubmit hook, which says only whether a person typed
 * it) and a note for each turn end (the Stop hook). So each digest also
 * lists, per session, the repo and its active minutes.
 *
 * What reaches the coach: the board's id and name, the repo's folder name,
 * the minutes, how many typed prompts and turn ends it counted, and a short
 * summary of each: what he asked, and what the session answered (the owner,
 * 2026-10-16: the digest shows what he did, not just minutes). The summary
 * is made from the prompt's text and the turn's closing message
 * (`coach/summary.ts`). Since 2026-10-18 the text goes too, whole up to the
 * wiring's per-mark cap, beside its summary: Bryan found the summaries cut
 * off and asked for the detail. The session id and the rest of the path
 * stay here.
 *
 * Who counts: any attached session he types into. A typed prompt starts a
 * run, and every mark after it counts while the run lasts: the turn ends,
 * and the prompts the harness injects (a channel event, a teammate
 * message). An injected prompt used to end the run, so on a busy lead the
 * turn ends after one counted nothing, and nine prompts in an hour came out
 * as one minute. A run lasts `RUN_IDLE_MS` past his last typed prompt, so a
 * lead working alone all day adds nothing, and turns only a channel woke
 * never open one.
 *
 * Active minutes. Every counted mark adds the time since the session's
 * previous mark, of any kind, capped:
 *  - a typed prompt adds at most `READ_CAP_MS`. That gap is him reading the
 *    last reply and writing the next prompt, which used to count nothing;
 *  - a turn end or an injected prompt adds at most `TURN_CAP_MS`, the agent
 *    working while he watches.
 * The caps are what keep a session left overnight from counting: the prompt
 * he types the next morning adds `READ_CAP_MS` at most, and nothing between
 * counts, because the run ended `RUN_IDLE_MS` after his last prompt. A mark
 * outside a run still moves the session's previous mark, so the reading
 * time a typed prompt adds is measured from the agent's last word. A
 * session's first mark has no gap and adds nothing; one with a typed prompt
 * and nothing else shows one minute.
 *
 * Pure apart from `SessionRuns`'s memory; every time is handed in.
 */
import { basename } from 'node:path';
import type { CoverageSource } from './coverage.ts';

/** The most a turn end or an injected prompt adds. */
export const TURN_CAP_MS = 5 * 60_000;
/** The most a typed prompt adds: reading the reply and writing the prompt. */
export const READ_CAP_MS = 10 * 60_000;
/** How long a run lasts past his last typed prompt. */
export const RUN_IDLE_MS = 30 * 60_000;
/** Sessions whose run is remembered before the oldest is forgotten. */
const SESSIONS_CAP = 500;
const REPO_MAX = 100;

export const SESSIONS_NOT_COUNTED =
  'Claude Code sessions that never joined a board are not counted, nor are headless runs (claude -p, the SDK), nor turns only a channel or another agent started.';

/** One counted mark in a run, with the time it adds: a typed prompt, an
 *  injected one, or a turn end. */
export interface SessionTurn {
  kind: 'prompt' | 'injected' | 'turn';
  at: number;
  boardId: string;
  board?: string;
  /** Which session; used to group, never sent. */
  session: string;
  repo: string;
  creditMs: number;
  /** Where he typed, for the coverage report (`coach/coverage.ts`); never sent. */
  source?: CoverageSource;
  /** The prompt he typed, or the turn's closing message, as the hook
   *  reduced it. Sent beside its summary, within the digest's budget. */
  text?: string;
}

/** One prompt or turn end in a session's line, said in a few words. */
export interface SessionActivity {
  at: number;
  kind: 'prompt' | 'turn';
  summary: string;
  /** The mark's text in full, as the session's hook sent it. */
  text?: string;
}

/** One session's line in a digest. */
export interface SessionMinutes {
  boardId: string;
  board?: string;
  repo: string;
  minutes: number;
  prompts: number;
  turns: number;
  /** Each mark that carried text, oldest first. */
  activity?: SessionActivity[];
}

/**
 * The repo's folder name from a session's working directory. A worktree under
 * `<repo>/.claude/worktrees/<name>` is its repo, not its branch folder.
 * Undefined for anything that is not an absolute path.
 */
export function repoOfCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return undefined;
  const trimmed = cwd.replace(/\/+$/, '');
  const worktree = trimmed.indexOf('/.claude/worktrees/');
  const root = worktree > 0 ? trimmed.slice(0, worktree) : trimmed;
  const name = basename(root);
  return name === '' || name.length > REPO_MAX ? undefined : name;
}

/** What a session's mark is, to its run. */
export type MarkKind = 'typed' | 'injected' | 'turn';

interface Run {
  /** The session's previous mark, of any kind. */
  last: number;
  /** His last typed prompt, if any. */
  typedAt?: number;
  source?: CoverageSource;
}

/** Each session's run: its previous mark and his last typed prompt. */
export class SessionRuns {
  private readonly runs = new Map<string, Run>();

  /** The time this mark adds, or null when it is outside a run. */
  mark(session: string, at: number, kind: MarkKind, source?: CoverageSource): number | null {
    const run = this.runs.get(session);
    // Most recent last, so the oldest is the one forgotten.
    this.runs.delete(session);
    const next: Run = { last: Math.max(run?.last ?? at, at) };
    if (run?.typedAt !== undefined) next.typedAt = run.typedAt;
    if (run?.source) next.source = run.source;
    if (source) next.source = source;
    let credit: number | null;
    const gap = run ? Math.max(0, at - run.last) : 0;
    if (kind === 'typed') {
      next.typedAt = Math.max(run?.typedAt ?? at, at);
      credit = Math.min(gap, READ_CAP_MS);
    } else {
      const live = next.typedAt !== undefined && at - next.typedAt <= RUN_IDLE_MS;
      credit = live ? Math.min(gap, TURN_CAP_MS) : null;
    }
    this.runs.set(session, next);
    while (this.runs.size > SESSIONS_CAP) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) break;
      this.runs.delete(oldest);
    }
    return credit;
  }

  /** Where the session's last prompt was typed, if it said. */
  sourceOf(session: string): CoverageSource | undefined {
    return this.runs.get(session)?.source;
  }
}

/** One line per session, in the order each first appears in the window.
 *  `summaryOf` says a mark's text in a few words, by its index in `turns`. */
export function sessionMinutesOf(
  turns: readonly SessionTurn[],
  summaryOf: (index: number) => string | undefined = () => undefined,
): SessionMinutes[] {
  const bySession = new Map<string, SessionMinutes & { ms: number }>();
  for (const [i, t] of turns.entries()) {
    const key = `${t.boardId}\u0000${t.session}`;
    const line = bySession.get(key) ?? {
      boardId: t.boardId,
      ...(t.board ? { board: t.board } : {}),
      repo: t.repo,
      minutes: 0,
      prompts: 0,
      turns: 0,
      ms: 0,
    };
    line.repo = t.repo;
    if (t.kind === 'prompt') line.prompts += 1;
    else if (t.kind === 'turn') line.turns += 1;
    line.ms += t.creditMs;
    // An injected prompt adds time, never a line: he did not write it.
    const kind = t.kind;
    const summary = kind === 'injected' ? undefined : summaryOf(i);
    if (summary && kind !== 'injected') {
      const text = t.text ? { text: t.text } : {};
      line.activity = [...(line.activity ?? []), { at: t.at, kind, summary, ...text }];
    }
    bySession.set(key, line);
  }
  return [...bySession.values()].map(({ ms, ...line }) => ({
    ...line,
    minutes: Math.max(1, Math.round(ms / 60_000)),
  }));
}
