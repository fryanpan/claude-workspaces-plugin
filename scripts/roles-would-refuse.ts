/**
 * Which edits report-only roles let through, per board — read before a board
 * starts enforcing, so nobody loses access they should have.
 *
 * `packages/server/src/socket-write-gate.ts` writes one `console.warn` line
 * per socket per refusal reason:
 *
 *   [roles] report-only, would refuse a role write on <docId> (board <ws>, role <role>)
 *   [roles] refused a role write on <docId> (board <ws>, role <role>)
 *
 * Under launchd that is the server's stderr, `StandardErrorPath` in the plist
 * `scripts/launchd/install.sh` renders: `~/Library/Logs/com.fryanpan.claude-workspaces.err.log`.
 * The squelch (`log-squelch.ts`) collapses identical lines inside a minute
 * into `[log-squelch] …repeated N more times in 60s: <line>`, so those are
 * counted too, N at a time.
 *
 * **The lines carry no clock.** A line with its own ISO stamp is dated by it;
 * any other is dated by the nearest stamped line ABOVE it in the same file,
 * which is a lower bound on when it was written. With `--days`, a record whose
 * bound falls inside the window is counted; one with no bound, or a bound
 * older than the window, is counted apart as `unplaced` rather than guessed
 * in or out. Without `--days` every record counts.
 *
 * Read-only: it opens the files it is given and writes only to stdout.
 *
 * Usage:
 *   bun run scripts/roles-would-refuse.ts [--days N] [--refused] [--json] [log ...]
 *
 * With no log named it reads the default err.log above. `--refused` counts the
 * refusals an enforcing board made instead of the ones report-only let through.
 */
import { createReadStream, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const DEFAULT_LOG = join(
  homedir(),
  'Library',
  'Logs',
  'com.fryanpan.claude-workspaces.err.log',
);

export type Verdict = 'would-refuse' | 'refused';

export interface Row {
  board: string;
  role: string;
  /** The refusal reason the gate names: `role`, `threads` or `unresolved`. */
  operation: string;
  /** Records placed inside the window (every record, without `--days`). */
  count: number;
  /** Records that could not be placed inside the window. */
  unplaced: number;
  /** Distinct docs the counted and unplaced records name. */
  docs: number;
}

export interface Summary {
  verdict: Verdict;
  /** Epoch ms of the window's start, or null for the whole log. */
  since: number | null;
  rows: Row[];
  /** Squelch summaries whose excerpt was cut before the board and role. */
  truncated: number;
}

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /;
const SQUELCH = /^\[log-squelch\] …repeated (\d+) more times? in \d+s: (.*)$/;
const ROLES =
  /^\[roles\] (refused|report-only, would refuse) a (\S+) write on (\S+) \(board (\S+), role (\S+)\)/;

interface Cell {
  count: number;
  unplaced: number;
  docs: Set<string>;
}

/** Fold log lines, one file at a time, into per-board counts. */
export class Tally {
  private readonly cells = new Map<string, Cell>();
  private truncated = 0;
  /** The latest stamp seen in the file being read. */
  private bound: number | null = null;

  constructor(
    private readonly verdict: Verdict,
    private readonly since: number | null,
  ) {}

  /** A new file: stamps above it say nothing about its lines. */
  startFile(): void {
    this.bound = null;
  }

  add(raw: string): void {
    let line = raw;
    const stamp = STAMP.exec(line);
    if (stamp?.[1]) {
      const at = Date.parse(stamp[1]);
      if (!Number.isNaN(at)) this.bound = at;
      line = line.slice(stamp[0].length);
    }
    let times = 1;
    const squelched = SQUELCH.exec(line);
    if (squelched?.[1] && squelched[2] !== undefined) {
      times = Number(squelched[1]);
      line = squelched[2];
    }
    if (!line.startsWith('[roles] ')) return;
    const m = ROLES.exec(line);
    if (!m) {
      if (squelched && line.endsWith('…')) this.truncated += times;
      return;
    }
    const [, said, operation = '', docId = '', board = '', role = ''] = m;
    if ((said === 'refused') !== (this.verdict === 'refused')) return;
    const key = `${board}\u0000${role}\u0000${operation}`;
    const cell = this.cells.get(key) ?? { count: 0, unplaced: 0, docs: new Set<string>() };
    const placed = this.since === null || (this.bound !== null && this.bound >= this.since);
    if (placed) cell.count += times;
    else cell.unplaced += times;
    cell.docs.add(docId);
    this.cells.set(key, cell);
  }

  summary(): Summary {
    const rows: Row[] = [...this.cells].map(([key, c]) => {
      const [board = '', role = '', operation = ''] = key.split('\u0000');
      return { board, role, operation, count: c.count, unplaced: c.unplaced, docs: c.docs.size };
    });
    rows.sort(
      (a, b) =>
        b.count - a.count ||
        b.unplaced - a.unplaced ||
        a.board.localeCompare(b.board) ||
        a.role.localeCompare(b.role) ||
        a.operation.localeCompare(b.operation),
    );
    return { verdict: this.verdict, since: this.since, rows, truncated: this.truncated };
  }
}

/** Summarise whole files' worth of lines, given as arrays (the test's door). */
export function summarise(
  files: string[][],
  opts: { verdict?: Verdict; since?: number | null } = {},
): Summary {
  const tally = new Tally(opts.verdict ?? 'would-refuse', opts.since ?? null);
  for (const lines of files) {
    tally.startFile();
    for (const line of lines) tally.add(line);
  }
  return tally.summary();
}

/** The table a person reads. */
export function render(s: Summary): string {
  const head = s.verdict === 'refused' ? 'refused' : 'would refuse';
  const window = s.since === null ? 'whole log' : `since ${new Date(s.since).toISOString()}`;
  const out = [`[roles] ${head}, ${window}`];
  if (s.rows.length === 0) {
    out.push('  no records');
  } else {
    out.push(
      `  ${'board'.padEnd(24)} ${'role'.padEnd(8)} ${'operation'.padEnd(10)} ${'count'.padStart(6)} ${'unplaced'.padStart(8)} ${'docs'.padStart(5)}`,
    );
    for (const r of s.rows) {
      out.push(
        `  ${r.board.padEnd(24)} ${r.role.padEnd(8)} ${r.operation.padEnd(10)} ${String(r.count).padStart(6)} ${String(r.unplaced).padStart(8)} ${String(r.docs).padStart(5)}`,
      );
    }
  }
  if (s.truncated > 0) {
    out.push(`  ${s.truncated} squelched record(s) cut before their board and role`);
  }
  return out.join('\n');
}

export interface Args {
  days: number | null;
  verdict: Verdict;
  json: boolean;
  files: string[];
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { days: null, verdict: 'would-refuse', json: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--days needs a positive number');
      args.days = n;
    } else if (a === '--refused') args.verdict = 'refused';
    else if (a === '--json') args.json = true;
    else if (a?.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else if (a) args.files.push(a);
  }
  if (args.files.length === 0) args.files.push(DEFAULT_LOG);
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const since = args.days === null ? null : Date.now() - args.days * 86_400_000;
  const tally = new Tally(args.verdict, since);
  for (const file of args.files) {
    if (!existsSync(file)) {
      console.error(`no such log: ${file}`);
      process.exit(2);
    }
    tally.startFile();
    const lines = createInterface({
      input: createReadStream(file),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) tally.add(line);
  }
  const s = tally.summary();
  console.log(args.json ? JSON.stringify(s, null, 2) : render(s));
}

if (import.meta.main) await main();
