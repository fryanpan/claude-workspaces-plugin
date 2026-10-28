/**
 * The transcript store's uploader: every Claude Code transcript and every
 * analytics log on this machine, sent as new objects to one bucket, each
 * sealed to the key its board decides.
 *
 * Files are assumed to be only appended to, and that is checked. Per file the
 * state keeps the bytes already sent and a hash of the last 4 KiB of them.
 * Each run sends whole lines past that point as
 * `<host>/<kind>/<board>/<name>/<offset>.jsonl.zst.cw`: zstd, then sealed with
 * `snapshot.ts`'s format. A file that shrank, or whose sent tail changed, is
 * sent again from offset 0 under `<name>/rewrite-<n>/`.
 *
 * The writing host comes first, so a writer's credential is a plain trailing
 * prefix, `<host>/*`. Boards are kept apart by their keys, not by the path.
 *
 * The offset in the key means no upload replaces another, so a create-only
 * credential is enough. The state is saved only after a put succeeds; a put
 * that landed but whose answer was lost is repeated at the same offset, and
 * the reader keeps one object per offset.
 *
 * Which key: an ordinary board's files go to the review key; a client or
 * private board's to its own key (the owner's when it has none configured);
 * a file with no board, or more than one, goes to `unsorted` under the
 * owner's key; a local-only board's files are never sent. A class that cannot
 * be read counts as private. The class is asked again for every chunk, so a
 * board made local-only stops at its next chunk; the folder a file went to
 * first is kept, so its chunks stay together.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { openBytes, sealBytes } from './snapshot.ts';

/** Where objects go. The real one is an S3 bucket; tests use a map. */
export interface ObjectStore {
  put(key: string, body: Uint8Array): Promise<void>;
}

export type BoardClass = 'ordinary' | 'private' | 'local-only';

/** Public keys (`cwsnap-pub-…`) only. No identity is ever on a machine that uploads. */
export interface StoreKeys {
  review: string;
  owner: string;
  /** Usage side files. Without it no usage file is written. */
  usage?: string;
  /** A client or private board's own key, by board id. */
  boards: Record<string, string>;
}

export interface UploadSource {
  path: string;
  kind: 'transcript' | 'event';
  /** The object path's name part, `/`-separated, e.g. a session id. */
  name: string;
  /** The board, or null when none or several claim the file. */
  board: string | null;
}

export interface RunOptions {
  sources: readonly UploadSource[];
  store: ObjectStore;
  statePath: string;
  host: string;
  keys: StoreKeys;
  classOf: (board: string) => BoardClass;
  /** Plaintext bytes per object at most, unless one line is longer. */
  maxChunkBytes?: number;
}

export interface RunReport {
  uploaded: { key: string; bytes: number }[];
  held: { path: string; reason: string }[];
}

interface FileState {
  sent: number;
  /** sha256 of the last `min(sent, 4 KiB)` bytes sent. */
  tail: string;
  folder: string;
  /** 0 until the file is first rewritten. */
  gen: number;
}

interface State {
  version: 1;
  files: Record<string, FileState>;
}

const UNSORTED = 'unsorted';
const TAIL = 4096;
const DEFAULT_MAX_CHUNK = 8 * 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

const validSegment = (s: string): boolean => SEGMENT.test(s);
const validBoard = (b: string): boolean => validSegment(b) && b !== UNSORTED;

export function loadState(path: string): State {
  if (!existsSync(path)) return { version: 1, files: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<State>;
  if (parsed.version !== 1 || typeof parsed.files !== 'object' || parsed.files === null) {
    throw new Error(`${path} is not an uploader state file`);
  }
  return { version: 1, files: parsed.files };
}

function saveState(path: string, state: State): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
}

function readRange(path: string, start: number, end: number): Buffer {
  const buf = Buffer.alloc(end - start);
  const fd = openSync(path, 'r');
  try {
    let got = 0;
    while (got < buf.length) {
      const r = readSync(fd, buf, got, buf.length - got, start + got);
      if (r === 0) break;
      got += r;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

function tailHash(path: string, sent: number): string {
  return createHash('sha256')
    .update(readRange(path, Math.max(0, sent - TAIL), sent))
    .digest('hex');
}

/** The recipient for a chunk in `folder`, or null when it must not leave. */
function recipientFor(folder: string, opts: RunOptions): string | null {
  if (folder === UNSORTED) return opts.keys.owner;
  let cls: BoardClass;
  try {
    cls = opts.classOf(folder);
  } catch {
    cls = 'private';
  }
  if (cls === 'local-only') return null;
  if (cls === 'ordinary') return opts.keys.review;
  return opts.keys.boards[folder] ?? opts.keys.owner;
}

/** Model, token counts and time of each assistant line. No text. */
export function usageLines(chunk: Buffer): string {
  let out = '';
  for (const raw of chunk.toString('utf8').split('\n')) {
    if (!raw) continue;
    let row: { timestamp?: unknown; message?: { model?: unknown; usage?: unknown } };
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }
    const usage = row.message?.usage;
    if (typeof usage !== 'object' || usage === null) continue;
    out += `${JSON.stringify({ ts: row.timestamp, model: row.message?.model, usage })}\n`;
  }
  return out;
}

const seal = (plain: Uint8Array, recipient: string): Buffer =>
  sealBytes(Bun.zstdCompressSync(plain), recipient);

/** One object's plaintext, given the identity it was sealed to. */
export function openChunk(body: Uint8Array, identity: string): Buffer {
  return Buffer.from(Bun.zstdDecompressSync(openBytes(body, identity)));
}

/** The next whole-line range past `sent`, or null when there is none yet. */
function nextChunk(path: string, sent: number, size: number, max: number): Buffer | null {
  if (size <= sent) return null;
  let bytes = readRange(path, sent, Math.min(size, sent + max));
  let end = bytes.lastIndexOf(0x0a);
  if (end < 0 && sent + bytes.length < size) {
    // One line longer than `max`: send it whole.
    bytes = readRange(path, sent, size);
    end = bytes.indexOf(0x0a);
  }
  return end < 0 ? null : bytes.subarray(0, end + 1);
}

/** One pass over every source. Throws on the first failed put, after saving what landed. */
export async function runOnce(opts: RunOptions): Promise<RunReport> {
  if (!validSegment(opts.host))
    throw new Error(`host ${JSON.stringify(opts.host)} is not a safe path segment`);
  const max = opts.maxChunkBytes ?? DEFAULT_MAX_CHUNK;
  const state = loadState(opts.statePath);
  const report: RunReport = { uploaded: [], held: [] };
  for (const src of opts.sources) {
    if (!src.name.split('/').every(validSegment)) {
      report.held.push({ path: src.path, reason: 'name is not a safe path' });
      continue;
    }
    let size: number;
    try {
      size = statSync(src.path).size;
    } catch {
      continue;
    }
    const prior = state.files[src.path];
    let rec: FileState = prior ?? {
      sent: 0,
      tail: tailHash(src.path, 0),
      folder: src.board !== null && validBoard(src.board) ? src.board : UNSORTED,
      gen: 0,
    };
    if (prior && (size < prior.sent || tailHash(src.path, prior.sent) !== prior.tail)) {
      rec = { ...prior, sent: 0, tail: tailHash(src.path, 0), gen: prior.gen + 1 };
    }
    const kind = src.kind === 'transcript' ? 'transcripts' : 'events';
    const genPart = rec.gen === 0 ? '' : `rewrite-${rec.gen}/`;
    for (;;) {
      const chunk = nextChunk(src.path, rec.sent, size, max);
      if (!chunk) break;
      const recipient = recipientFor(rec.folder, opts);
      if (recipient === null) {
        report.held.push({ path: src.path, reason: 'local-only board' });
        break;
      }
      const tail = `${rec.folder}/${src.name}/${genPart}${rec.sent}.jsonl.zst.cw`;
      const key = `${opts.host}/${kind}/${tail}`;
      await opts.store.put(key, seal(chunk, recipient));
      report.uploaded.push({ key, bytes: chunk.length });
      const usage = src.kind === 'transcript' && opts.keys.usage ? usageLines(chunk) : '';
      if (usage && opts.keys.usage) {
        await opts.store.put(
          `${opts.host}/usage/${tail}`,
          seal(Buffer.from(usage), opts.keys.usage),
        );
      }
      const sent = rec.sent + chunk.length;
      rec = { ...rec, sent, tail: tailHash(src.path, sent) };
      state.files[src.path] = rec;
      saveState(opts.statePath, state);
    }
  }
  return report;
}

/** Session id -> board, from the ledger the session hooks append to. */
export function ledgerResolver(ledgerPath: string): (session: string) => string | null {
  const boards = new Map<string, Set<string>>();
  if (existsSync(ledgerPath)) {
    for (const raw of readFileSync(ledgerPath, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let row: { session?: unknown; board?: unknown };
      try {
        row = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof row.session !== 'string' || typeof row.board !== 'string') continue;
      const set = boards.get(row.session) ?? new Set<string>();
      set.add(row.board);
      boards.set(row.session, set);
    }
  }
  return (session) => {
    const set = boards.get(session);
    if (!set || set.size !== 1) return null;
    const [only] = set;
    return only ?? null;
  };
}

function jsonlUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonlUnder(p));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/**
 * Every transcript under Claude Code's projects dir. `<slug>/<session>.jsonl`
 * is a session; `<slug>/<session>/subagents/<agent>.jsonl` goes with its
 * session, under `<session>/subagents/<agent>`.
 */
export function transcriptSources(
  projectsDir: string,
  boardOf: (session: string) => string | null,
): UploadSource[] {
  if (!existsSync(projectsDir)) return [];
  return jsonlUnder(projectsDir).flatMap((path): UploadSource[] => {
    const parts = relative(projectsDir, path).slice(0, -'.jsonl'.length).split(sep);
    const rest = parts.slice(1);
    const session = rest[0];
    if (!session) return [];
    return [{ path, kind: 'transcript', name: rest.join('/'), board: boardOf(session) }];
  });
}

const BOARD_LOG = /^(.+)\.(events|agent-notes|load-reports)\.jsonl$/;

/**
 * A data dir's analytics logs. A per-board log (`workspaces/<board>.events.jsonl`
 * and its siblings) goes under its board. The whole-server logs at the data
 * dir's top cover every board, so they are sent only on a machine that serves
 * one board, `fixedBoard`, under which everything here goes.
 */
export function eventSources(dataDir: string, fixedBoard?: string): UploadSource[] {
  const out: UploadSource[] = [];
  const ws = join(dataDir, 'workspaces');
  if (existsSync(ws)) {
    for (const file of readdirSync(ws)) {
      const m = BOARD_LOG.exec(file);
      if (!m?.[1]) continue;
      const name = file.slice(0, -'.jsonl'.length);
      out.push({ path: join(ws, file), kind: 'event', name, board: fixedBoard ?? m[1] });
    }
  }
  if (fixedBoard !== undefined && existsSync(dataDir)) {
    for (const file of readdirSync(dataDir)) {
      const path = join(dataDir, file);
      if (!file.endsWith('.jsonl') || !statSync(path).isFile()) continue;
      out.push({ path, kind: 'event', name: basename(file, '.jsonl'), board: fixedBoard });
    }
  }
  return out;
}
