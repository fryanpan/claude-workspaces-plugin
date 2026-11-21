/**
 * What `machine:tokens burn` does: copy each project lead's billed turns from
 * its machine to this Mac, into the folder budget watch already walks.
 *
 * Budget watch (`fleet_budget_watch.py`, in the fleet repo) sums the token
 * counts in every transcript under `~/.claude/projects`, per folder, and
 * names each folder's project. A lead on a Fly machine writes its
 * transcripts there instead, so its spend was invisible to it. This writes
 * the machine's turns as transcript lines holding the counts and nothing
 * else, under `~/.claude/projects/cw-machine-<project>/`, so budget watch
 * shows the machine as one more row beside the Mac's projects with no change
 * to budget watch. The folder name cannot be a real one: Claude Code names a
 * folder for an absolute path, so its names start with `-`.
 *
 * The read is `lead-turns.ts`, run as the `lead` user over `fly ssh console`
 * with the app's own token, the same path and the same credential as
 * `machine:tokens usage` (`token-usage.ts`). No new secret and nothing new on
 * the machine is reachable from outside. The machine does not push: with the
 * Mac off, nothing reads budget watch either.
 *
 * Main-session turns go to `lead.jsonl` and subagent turns to
 * `subagents/agents.jsonl`, because budget watch reads context size off a
 * folder's top-level transcripts only. Each pull asks for the turns since an
 * hour before the newest one already copied, and the files keep eight days,
 * one more than the longest window budget watch measures.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_NAME } from './deploy-plan.ts';
import { MAX_COUNT, MODEL, REQUEST_ID, type Turn } from './lead-turns.ts';
import { onMachine } from './mac-ops.ts';
import { LEAD_ROOT, MACHINE_PATH, asLead, declaredProjects, hasLead } from './token-usage.ts';

const START = 'cw-turns-start';
export const KEEP_MS = 8 * 86_400_000;
const OVERLAP_MS = 3_600_000;
/** A turn dated this far ahead of the Mac's clock is not taken. */
const SKEW_MS = 5 * 60_000;
/** About 20,000 turns: far past a day of one lead's work. */
const MAX_BYTES = 4 * 1024 * 1024;

/** Where budget watch reads transcripts. CW_BUDGET_PROJECTS_DIR is for a test. */
export const budgetProjectsDir = (): string =>
  process.env.CW_BUDGET_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
export const burnFolder = (project: string): string => `cw-machine-${project}`;

/** The read, as the lead, bounded in time and size. Single-quote free: `asLead` quotes it. */
export const burnReadCommand = (
  since: number,
  root = LEAD_ROOT,
  path = MACHINE_PATH,
  app = '/app',
): string =>
  asLead(
    `echo ${START}; timeout 60 bun ${app}/infra/project-machine/lead-turns.ts ${root} ${Math.floor(since)} 2>/dev/null | head -c ${MAX_BYTES}; exit 0`,
    path,
  );

const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;

/** A turn exactly as `lead-turns.ts` prints one, or null. */
function checkedTurn(v: unknown, since: number, now: number): Turn | null {
  const o = v as Partial<Turn> | null;
  if (!o || typeof o !== 'object') return null;
  if (typeof o.t !== 'number' || !Number.isFinite(o.t) || o.t < since || o.t > now + SKEW_MS)
    return null;
  if (typeof o.r !== 'string' || !REQUEST_ID.test(o.r)) return null;
  if (typeof o.m !== 'string' || !MODEL.test(o.m)) return null;
  if (o.s !== 0 && o.s !== 1) return null;
  if (!count(o.i) || !count(o.o) || !count(o.cc) || !count(o.cr)) return null;
  return { t: o.t, r: o.r, m: o.m, s: o.s, i: o.i, o: o.o, cc: o.cc, cr: o.cr };
}

/**
 * The turns in what the machine answered. Everything before the marker is
 * ssh's; every line after it is checked field by field, because the lead
 * wrote the transcripts it came from. A line that fails is dropped alone.
 */
export function parseTurns(stdout: string, since: number, now: number): Turn[] {
  const lines = stdout.split(/\r?\n/);
  const at = lines.indexOf(START);
  if (at < 0) throw new Error('the machine did not run the read');
  const turns: Turn[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const t = checkedTurn(v, since, now);
    if (t) turns.push(t);
  }
  return turns;
}

/** A turn as a transcript line: what budget watch's `window_burn` reads, and no more. */
export const transcriptLine = (t: Turn): string =>
  JSON.stringify({
    timestamp: new Date(t.t).toISOString(),
    requestId: t.r,
    message: {
      model: t.m,
      usage: {
        input_tokens: t.i,
        output_tokens: t.o,
        cache_creation_input_tokens: t.cc,
        cache_read_input_tokens: t.cr,
      },
    },
  });

/** A line this module wrote, read back. Anything else in the file is dropped. */
function fromTranscriptLine(line: string, sub: 0 | 1, since: number, now: number): Turn | null {
  try {
    const o = JSON.parse(line) as {
      timestamp?: string;
      requestId?: unknown;
      message?: { model?: unknown; usage?: Record<string, unknown> };
    };
    const u = o.message?.usage ?? {};
    return checkedTurn(
      {
        t: Date.parse(o.timestamp ?? ''),
        r: o.requestId,
        m: o.message?.model,
        s: sub,
        i: u.input_tokens,
        o: u.output_tokens,
        cc: u.cache_creation_input_tokens,
        cr: u.cache_read_input_tokens,
      },
      since,
      now,
    );
  } catch {
    return null;
  }
}

const FILES = [
  { sub: 0, rel: 'lead.jsonl' },
  { sub: 1, rel: join('subagents', 'agents.jsonl') },
] as const;

function readCopied(folder: string, since: number, now: number): Turn[] {
  const turns: Turn[] = [];
  for (const f of FILES) {
    const path = join(folder, f.rel);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim() ? fromTranscriptLine(line, f.sub, since, now) : null;
      if (t) turns.push(t);
    }
  }
  return turns;
}

/** Both sets, each request once (the newer read wins), oldest first. */
export function mergeTurns(before: readonly Turn[], pulled: readonly Turn[]): Turn[] {
  const byId = new Map<string, Turn>();
  for (const t of [...before, ...pulled]) byId.set(t.r, t);
  return [...byId.values()].sort((a, b) => a.t - b.t);
}

function writeAtomic(path: string, body: string): void {
  const part = `${path}.${process.pid}`;
  writeFileSync(part, body, { mode: 0o600 });
  renameSync(part, path);
}

export interface BurnResult {
  project: string;
  /** Turns new to this Mac in this pull. */
  added: number;
  /** Tokens in the copied turns of the last five hours. */
  lastFiveHours: number;
  error?: string;
}

export interface BurnOptions {
  /** Defaults to `~/.claude/projects`. */
  dest?: string;
  now?: number;
  /** Runs the read on the project's machine; defaults to `fly ssh console`. */
  read?: (app: string, command: string) => string;
  declared?: () => string[];
}

const tokens = (t: Turn) => t.i + t.o + t.cc + t.cr;

/** Pull one project's turns into its folder under `dest`. */
export function pullProjectBurn(project: string, opts: BurnOptions = {}): BurnResult {
  if (!PROJECT_NAME.test(project)) throw new Error(`${project} is not a project name`);
  const now = opts.now ?? Date.now();
  const dest = opts.dest ?? budgetProjectsDir();
  const read = opts.read ?? onMachine;
  const keepSince = now - KEEP_MS;
  const folder = join(dest, burnFolder(project));
  const before = readCopied(folder, keepSince, now);
  const newest = before.at(-1)?.t ?? keepSince;
  const since = Math.max(keepSince, newest - OVERLAP_MS);
  let pulled: Turn[];
  try {
    pulled = parseTurns(read(`cw-${project}`, burnReadCommand(since)), since, now);
  } catch {
    return { project, added: 0, lastFiveHours: 0, error: 'could not read the machine' };
  }
  const known = new Set(before.map((t) => t.r));
  const merged = mergeTurns(before, pulled);
  mkdirSync(join(folder, 'subagents'), { recursive: true, mode: 0o700 });
  for (const f of FILES) {
    const lines = merged.filter((t) => t.s === f.sub).map(transcriptLine);
    writeAtomic(join(folder, f.rel), lines.length ? `${lines.join('\n')}\n` : '');
  }
  const cutoff = now - 5 * 3_600_000;
  return {
    project,
    added: pulled.filter((t) => !known.has(t.r)).length,
    lastFiveHours: merged.filter((t) => t.t >= cutoff).reduce((n, t) => n + tokens(t), 0),
  };
}

/** Every project named, or every declared project whose app has a lead. */
export function pullBurn(named: readonly string[], opts: BurnOptions = {}): BurnResult[] {
  const projects =
    named.length > 0
      ? [...named]
      : (opts.declared ?? declaredProjects)()
          .filter((p) => hasLead(`cw-${p}`))
          .sort();
  return projects.map((p) => pullProjectBurn(p, opts));
}

export const burnLine = (r: BurnResult): string =>
  r.error
    ? `[${r.project}]: ${r.error}`
    : `[${r.project}]: ${r.added} new turns; ${(r.lastFiveHours / 1e6).toFixed(1)}M tokens in the last 5h, in ${burnFolder(r.project)}`;
