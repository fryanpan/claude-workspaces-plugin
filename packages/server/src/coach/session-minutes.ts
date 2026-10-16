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
 * (`coach/summary.ts`); the text itself, the session id and the rest of the
 * path stay here.
 *
 * Who counts: any attached session he types into. A typed prompt starts a
 * run, and the turn ends that follow it count until the next prompt the
 * harness injected (a channel event, a teammate message). Turns that only a
 * channel woke never count, so a lead working alone all day adds nothing.
 *
 * Active minutes. Each turn end in a run adds the time since the run's
 * previous mark, its typed prompt or its last turn end, at most
 * `TURN_CAP_MS`. Five minutes is about one read-and-reply; a longer gap is
 * time the session worked alone or he was elsewhere, and counting it whole
 * is what would overstate. A session with a typed prompt and no turn end
 * yet shows one minute.
 *
 * Pure apart from `SessionRuns`'s memory; every time is handed in.
 */
import { basename } from 'node:path';

/** The most one turn end adds. */
export const TURN_CAP_MS = 5 * 60_000;
/** Sessions whose run is remembered before the oldest is forgotten. */
const SESSIONS_CAP = 500;
const REPO_MAX = 100;

export const SESSIONS_NOT_COUNTED =
  'Claude Code sessions that never joined a board are not counted, nor are headless runs (claude -p, the SDK), nor turns only a channel or another agent started.';

/** One counted mark: a typed prompt, or a turn end in its run with the time it adds. */
export interface SessionTurn {
  kind: 'prompt' | 'turn';
  at: number;
  boardId: string;
  board?: string;
  /** Which session; used to group, never sent. */
  session: string;
  repo: string;
  creditMs: number;
  /** The prompt he typed, or the turn's closing message, as the hook
   *  reduced it. Summarised before a digest goes; never sent whole. */
  text?: string;
}

/** One prompt or turn end in a session's line, said in a few words. */
export interface SessionActivity {
  at: number;
  kind: 'prompt' | 'turn';
  summary: string;
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

/** Each session's open run: when its last mark was, from a typed prompt on. */
export class SessionRuns {
  private readonly last = new Map<string, number>();

  /** A typed prompt opens a run; an injected one closes it. */
  prompt(session: string, at: number, typed: boolean): void {
    this.last.delete(session);
    if (!typed) return;
    this.last.set(session, at);
    while (this.last.size > SESSIONS_CAP) {
      const oldest = this.last.keys().next().value;
      if (oldest === undefined) break;
      this.last.delete(oldest);
    }
  }

  /** The time this turn end adds, or null outside a run. */
  turnEnd(session: string, at: number): number | null {
    const prev = this.last.get(session);
    if (prev === undefined) return null;
    this.last.set(session, Math.max(prev, at));
    return Math.min(Math.max(0, at - prev), TURN_CAP_MS);
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
    else line.turns += 1;
    line.ms += t.creditMs;
    const summary = summaryOf(i);
    if (summary) line.activity = [...(line.activity ?? []), { at: t.at, kind: t.kind, summary }];
    bySession.set(key, line);
  }
  return [...bySession.values()].map(({ ms, ...line }) => ({
    ...line,
    minutes: Math.max(1, Math.round(ms / 60_000)),
  }));
}
