/**
 * One board's fingerprint, read the way a person and an agent read it: its
 * docs' text, every thread and comment on its docs and rows, its tasks, and
 * its two append-only logs. `move-board.ts` takes one on the source before
 * the export and one on the target after the import, and archives the source
 * only when they match. It runs on the Mac against the source and, through
 * `board-probe.ts`, on the machine against the target, both on loopback.
 *
 * A listed doc whose content and threads both answer 404 is a dangling id:
 * the board names a doc the server does not have. It is fingerprinted as
 * `<id>\tmissing`, and the export carries the id with no files, so the
 * target names it too and the two prints still compare.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type LogFingerprint, logFingerprint } from './deploy-plan.ts';

export interface Part {
  count: number;
  sha256: string;
}

export interface BoardPrint {
  name: string;
  docs: Part;
  threads: Part;
  tasks: Part;
  events: LogFingerprint;
  notes: LogFingerprint;
  /** Listed doc ids the server has neither content nor threads for. */
  dangling: string[];
}

export const BOARD_LOGS = ['events', 'notes'] as const;
export type BoardLimits = Partial<Record<(typeof BOARD_LOGS)[number], Record<string, number>>>;

const hex = (s: string): string => createHash('sha256').update(s).digest('hex');

function part(lines: string[]): Part {
  return { count: lines.length, sha256: hex([...lines].sort().join('\n')) };
}

type Call = (path: string) => Promise<Record<string, unknown>>;

/** A GET that did not answer 2xx; `status` tells a 404 from the rest. */
export class GetFailed extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const is404 = (e: unknown): boolean => e instanceof GetFailed && e.status === 404;

/** A GET on a board server over loopback, as its own machine. */
export function loopbackGet(base: string): Call {
  const host = `localhost:${new URL(base).port || '80'}`;
  return async (path) => {
    const res = await fetch(`${base}${path}`, { headers: { host } });
    const text = await res.text();
    if (!res.ok)
      throw new GetFailed(res.status, `GET ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
}

interface Thread {
  id: string;
  status?: string;
  comments?: { id?: string; text?: string; author?: string }[];
}

export async function boardPrint(
  get: Call,
  dataDir: string,
  boardId: string,
  limits: BoardLimits = {},
): Promise<BoardPrint> {
  const b = encodeURIComponent(boardId);
  const ws = (await get(`/workspaces/${b}?format=json`)).workspace as {
    name: string;
    docIds?: string[];
  };
  const listed = (await get(`/workspaces/${b}/tasks?format=json&includeArchived=true`)).tasks as {
    id: string;
    title: string;
    status: string;
  }[];
  const docs: string[] = [];
  const threads: string[] = [];
  const dangling: string[] = [];
  const docIds = [...(ws.docIds ?? []), ...listed.map((t) => `task:${t.id}`)];
  for (const docId of docIds) {
    const d = encodeURIComponent(docId);
    let missing: unknown;
    if (!docId.startsWith('task:')) {
      try {
        const c = await get(`/workspaces/${b}/docs/${d}/content`);
        docs.push(`${docId}\t${hex(String(c.plainText ?? ''))}`);
      } catch (e) {
        if (!is404(e)) throw e;
        missing = e;
      }
    }
    let t: Thread[];
    try {
      t = (await get(`/workspaces/${b}/docs/${d}/threads`)).threads as Thread[];
    } catch (e) {
      if (missing === undefined || !is404(e)) throw e;
      docs.push(`${docId}\tmissing`);
      dangling.push(docId);
      continue;
    }
    // Threads without content is a broken doc, not a dangling id.
    if (missing !== undefined) throw missing;
    for (const th of t ?? []) {
      const words = (th.comments ?? []).map((c) => `${c.id}:${c.author}:${c.text}`).join('\n');
      threads.push(`${docId}\t${th.id}\t${th.status}\t${hex(words)}`);
    }
  }
  const tasks = listed.map((t) => `${t.id}\t${t.status}\t${hex(t.title)}`);
  const log = (suffix: string, lim?: Record<string, number>) => {
    const name = `${boardId}${suffix}`;
    const path = join(dataDir, 'workspaces', name);
    const files = existsSync(path) ? [{ path: name, text: readFileSync(path, 'utf8') }] : [];
    return logFingerprint(files, lim);
  };
  return {
    name: ws.name,
    docs: part(docs),
    threads: part(threads),
    tasks: part(tasks),
    events: log('.events.jsonl', limits.events),
    notes: log('.agent-notes.jsonl', limits.notes),
    dangling,
  };
}

/** The limits the target's logs are cut to: what the source held at export. */
export function boardLimits(before: BoardPrint): BoardLimits {
  return { events: before.events.linesByFile, notes: before.notes.linesByFile };
}

/** One line per part, and whether every part matched. */
export function judgeMove(before: BoardPrint, after: BoardPrint): { ok: boolean; lines: string[] } {
  const rows = [
    { what: 'name', b: 1, a: 1, same: before.name === after.name, sha: hex(before.name) },
    ...(['docs', 'threads', 'tasks'] as const).map((k) => ({
      what: k,
      b: before[k].count,
      a: after[k].count,
      same: before[k].sha256 === after[k].sha256,
      sha: before[k].sha256,
    })),
    ...BOARD_LOGS.map((k) => ({
      what: k,
      b: before[k].lines,
      a: after[k].lines,
      same: before[k].sha256 === after[k].sha256,
      sha: before[k].sha256,
    })),
  ];
  const lines = rows.map(
    (r) =>
      `${r.a === r.b && r.same ? 'PASS' : 'FAIL'} ${r.what}: ${r.b} -> ${r.a}, sha256 ${r.sha.slice(0, 12)} ${r.same ? 'matches' : 'DIFFERS'}`,
  );
  return { ok: rows.every((r) => r.a === r.b && r.same), lines };
}
