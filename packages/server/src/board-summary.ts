/**
 * Two lines under each project on the all-workspaces page: what that board
 * has been doing in the last hour, in Haiku's words.
 *
 * The reader scans the project list to decide where to spend a sitting, and a
 * board name plus a time says nothing about what is moving. So each board
 * gets one short sentence, written from that board's own last hour of events
 * — task moves, answers, and the one-line notes sessions post as they work.
 *
 * Three rules keep it cheap and honest:
 *
 *  - **At most once an hour per board.** A refresh is asked for on every page
 *    load and declined unless the stored sentence is an hour old, the board
 *    had events in the last hour, and no refresh for it is already out.
 *  - **Quiet boards say nothing.** A sentence older than two hours describes
 *    work that has stopped, so the page shows only the last active time.
 *  - **Short or nothing.** The sentence has to fit two lines at phone width
 *    beside the time, so a reply longer than `SUMMARY_MAX_CHARS` is refused
 *    rather than clipped mid-word.
 *
 * The key handling is the existing summarizer's (`summarize.ts`): prod reads
 * its own key, every other server the eval key, `CW_SUMMARIES=0` turns it off.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BriefEventRow, readEventRows } from './home-brief.ts';

const FILENAME = 'board-summaries.json';
export const SUMMARY_WINDOW_MS = 60 * 60_000;
export const SUMMARY_SHOW_MS = 2 * 60 * 60_000;
/** Fits two lines at 430px with the last-active time after it. */
export const SUMMARY_MAX_CHARS = 80;
const PROMPT_MAX_ROWS = 60;
const RETRY_MS = 15 * 60_000;
const NOTE_MAX_CHARS = 280;

export interface StoredBoardSummary {
  text: string;
  at: number;
}

export interface BoardSummaryGenerator {
  generateBoardSummary(prompt: { system: string; user: string }): Promise<string | null>;
}

export const BOARD_SUMMARY_SYSTEM = `You write one sentence saying what a project board worked on in the last hour.
Plain words, present tense, no names of people, no counts, no markdown, no quotes.
At most ${SUMMARY_MAX_CHARS} characters. If nothing meaningful happened, reply with an empty line.`;

/** The last hour, one line a row, oldest first. Heartbeats are not work. */
export function boardSummaryPrompt(args: {
  name: string;
  rows: BriefEventRow[];
  titleOf: (taskId: string) => string | undefined;
  now: number;
}): string | null {
  const since = args.now - SUMMARY_WINDOW_MS;
  const lines: string[] = [];
  const recent = args.rows
    .filter(
      (r) =>
        typeof r.event === 'string' &&
        !r.event.startsWith('agent.') &&
        typeof r.ts === 'number' &&
        r.ts > since,
    )
    .sort((a, b) => (a.ts as number) - (b.ts as number))
    .slice(-PROMPT_MAX_ROWS);
  for (const r of recent) {
    const title = typeof r.taskId === 'string' ? args.titleOf(r.taskId) : undefined;
    const text = typeof r.text === 'string' ? r.text.slice(0, NOTE_MAX_CHARS) : '';
    const to = typeof r.to === 'string' ? ` → ${r.to}` : '';
    lines.push(
      [r.event as string, title ? `"${title}"` : '', to, text ? `: ${text}` : '']
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  if (lines.length === 0) return null;
  return `Board: ${args.name}\nEvents in the last hour:\n${lines.join('\n')}`;
}

/** A usable sentence, or null. Never clipped: a long reply is refused. */
export function acceptBoardSummary(reply: string | null): string | null {
  if (reply === null) return null;
  const text = reply
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^"(.*)"$/, '$1');
  if (text.length < 12 || text.length > SUMMARY_MAX_CHARS) return null;
  return text;
}

export class BoardSummaryStore {
  private readonly path: string;
  private readonly byBoard = new Map<string, StoredBoardSummary>();

  constructor(dataDir: string) {
    this.path = join(dataDir, FILENAME);
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>;
      for (const [id, v] of Object.entries(parsed)) {
        const s = v as Partial<StoredBoardSummary>;
        if (typeof s?.text === 'string' && typeof s.at === 'number') {
          this.byBoard.set(id, { text: s.text, at: s.at });
        }
      }
    } catch {
      // A corrupt file costs one hour of summaries, nothing else.
    }
  }

  get(workspaceId: string): StoredBoardSummary | undefined {
    return this.byBoard.get(workspaceId);
  }

  set(workspaceId: string, summary: StoredBoardSummary): void {
    this.byBoard.set(workspaceId, summary);
    mkdirSync(join(this.path, '..'), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(this.byBoard))}\n`);
    renameSync(tmp, this.path);
  }
}

export interface BoardSummaries {
  /** The sentence to show, or undefined when the board has gone quiet. */
  read(workspaceId: string): string | undefined;
  /** Ask for a fresh sentence; declined unless one is due. Never throws. */
  refresh(board: { id: string; name: string }): Promise<void>;
}

export function createBoardSummaries(deps: {
  dataDir: string;
  summarizer: BoardSummaryGenerator | null;
  titleOf: (taskId: string) => string | undefined;
  now?: () => number;
  readRows?: (workspaceId: string) => BriefEventRow[];
}): BoardSummaries {
  const now = deps.now ?? Date.now;
  const readRows = deps.readRows ?? ((id: string) => readEventRows(deps.dataDir, id));
  const store = new BoardSummaryStore(deps.dataDir);
  const inflight = new Set<string>();
  const tried = new Map<string, number>();

  return {
    read(workspaceId) {
      const s = store.get(workspaceId);
      return s && now() - s.at < SUMMARY_SHOW_MS ? s.text : undefined;
    },
    async refresh(board) {
      const { summarizer } = deps;
      if (!summarizer || inflight.has(board.id)) return;
      const t = now();
      const stored = store.get(board.id);
      if (stored && t - stored.at < SUMMARY_WINDOW_MS) return;
      // The page asks on every load, and reading a board's log to find a
      // quiet hour costs the same as finding a busy one.
      const last = tried.get(board.id);
      if (last !== undefined && t - last < RETRY_MS) return;
      tried.set(board.id, t);
      inflight.add(board.id);
      try {
        const user = boardSummaryPrompt({
          name: board.name,
          rows: readRows(board.id),
          titleOf: deps.titleOf,
          now: t,
        });
        if (user === null) return;
        const text = acceptBoardSummary(
          await summarizer.generateBoardSummary({ system: BOARD_SUMMARY_SYSTEM, user }),
        );
        if (text) store.set(board.id, { text, at: t });
      } catch (err) {
        console.error('[board-summary] refresh failed:', err instanceof Error ? err.message : err);
      } finally {
        inflight.delete(board.id);
      }
    },
  };
}
