/**
 * The transcript store's uploader: every Claude Code transcript and every
 * analytics log on this machine, sent as new objects to one bucket, each
 * sealed to the keys its board decides.
 *
 * Files are assumed to be only appended to, and that is checked. Per file the
 * state keeps the bytes already sent and a hash of the last 4 KiB of them.
 * Each run sends whole lines past that point as a new object, zstd then
 * sealed in `seal.ts`'s v2 format, named `<offset>-<random>.jsonl.zst.cw`:
 *
 *   <host>/transcripts/<board>/<name>/<offset>-<random>.jsonl.zst.cw
 *   <host>/events/<board>/<name>/<YYYY-MM-DD>/<offset>-<random>.jsonl.zst.cw
 *
 * A file that shrank, or whose sent tail changed, is sent again from offset 0
 * under `<name>/rewrite-<n>/`.
 *
 * The writing host comes first, so a writer's credential is a plain trailing
 * prefix, `<host>/*`. Boards are kept apart by their keys, not by the path.
 * The random part means a credential that cannot list cannot name an object
 * to overwrite it.
 *
 * The state is saved only after a put succeeds; a put that landed but whose
 * answer was lost is repeated at the same offset under a new name, and the
 * reader keeps one object per offset (the check counts it as a duplicate).
 *
 * Which keys: every chunk goes to the review key, because the weekly review
 * reads everything (Bryan, 30 Oct). An ordinary board's chunk goes to it
 * alone; a client, private or local-only board's also to its own key (the
 * owner's when it has none configured); a file with no board, or more than
 * one, goes to `unsorted` under the owner's key as well. A class that cannot
 * be read counts as private. The folder a file went to first is kept, so its
 * chunks stay together.
 *
 * Each UTC day, every file that sent a chunk gets a manifest naming each
 * chunk, its range and the sha256 of its plain bytes, at
 * `<host>/manifests/<YYYY-MM-DD>/<kind>/<board>/<name>.json.zst.cw`. The
 * first pass after midnight closes the old day and its chunks belong to it,
 * so a day's manifests cover every byte written before its midnight. The
 * check (`store-check.ts`) reads them to tell a deleted chunk from one that
 * was never sent.
 */
import { createHash, randomBytes } from 'node:crypto';
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
import { openBytes, sealBytes } from './seal.ts';

/** Where objects go. The real one is an S3 bucket; tests use a map. */
export interface ObjectStore {
  put(key: string, body: Uint8Array): Promise<void>;
}

/**
 * A store's answer that this object can never be taken, as opposed to a put
 * that failed and may succeed next pass. `runOnce` holds the file and says
 * why, and carries on with the others.
 */
export class RefusedObject extends Error {}

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
  /** The clock that decides the UTC day. */
  now?: () => Date;
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

export interface ManifestChunk {
  key: string;
  offset: number;
  bytes: number;
  /** sha256 of the chunk's plain bytes. */
  sha256: string;
}

export interface Manifest {
  version: 1;
  host: string;
  day: string;
  kind: 'transcripts' | 'events';
  folder: string;
  name: string;
  gen: number;
  chunks: ManifestChunk[];
}

/** The open day's chunks, per file, until the day closes. */
interface Pending {
  day: string;
  files: Record<string, Omit<Manifest, 'version' | 'host' | 'day'>>;
}

interface State {
  version: 1;
  files: Record<string, FileState>;
  pending?: Pending;
}

export const UNSORTED = 'unsorted';
const TAIL = 4096;
const DEFAULT_MAX_CHUNK = 8 * 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export const validSegment = (s: string): boolean => SEGMENT.test(s);
export const validBoard = (b: string): boolean => validSegment(b) && b !== UNSORTED;

export function loadState(path: string): State {
  if (!existsSync(path)) return { version: 1, files: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<State>;
  if (parsed.version !== 1 || typeof parsed.files !== 'object' || parsed.files === null) {
    throw new Error(`${path} is not an uploader state file`);
  }
  return {
    version: 1,
    files: parsed.files,
    ...(parsed.pending ? { pending: parsed.pending } : {}),
  };
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

/** The keys a chunk in `folder` is sealed to. The review key is always one. */
function recipientsFor(folder: string, opts: RunOptions): string[] {
  if (folder === UNSORTED) return [opts.keys.owner, opts.keys.review];
  let cls: BoardClass;
  try {
    cls = opts.classOf(folder);
  } catch {
    cls = 'private';
  }
  if (cls === 'ordinary') return [opts.keys.review];
  return [opts.keys.boards[folder] ?? opts.keys.owner, opts.keys.review];
}

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Where a manifest goes. */
export function manifestKey(
  m: Pick<Manifest, 'host' | 'day' | 'kind' | 'folder' | 'name' | 'gen'>,
) {
  const gen = m.gen === 0 ? '' : `/rewrite-${m.gen}`;
  return `${m.host}/manifests/${m.day}/${m.kind}/${m.folder}/${m.name}${gen}.json.zst.cw`;
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

export const seal = (plain: Uint8Array, recipients: string | readonly string[]): Buffer =>
  sealBytes(Bun.zstdCompressSync(plain), recipients);

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

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** One pass over every source. Throws on the first failed put, after saving what landed. */
export async function runOnce(opts: RunOptions): Promise<RunReport> {
  if (!validSegment(opts.host))
    throw new Error(`host ${JSON.stringify(opts.host)} is not a safe path segment`);
  const max = opts.maxChunkBytes ?? DEFAULT_MAX_CHUNK;
  const state = loadState(opts.statePath);
  const today = utcDay((opts.now ?? (() => new Date()))());
  // This pass's chunks belong to the open day, even when it has just ended.
  const pending: Pending = state.pending ?? { day: today, files: {} };
  state.pending = pending;
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
    const dayPart = kind === 'events' ? `${pending.day}/` : '';
    for (;;) {
      const chunk = nextChunk(src.path, rec.sent, size, max);
      if (!chunk) break;
      const name = `${rec.sent}-${randomBytes(8).toString('hex')}.jsonl.zst.cw`;
      const tail = `${rec.folder}/${src.name}/${dayPart}${genPart}${name}`;
      const key = `${opts.host}/${kind}/${tail}`;
      try {
        await opts.store.put(key, seal(chunk, recipientsFor(rec.folder, opts)));
      } catch (err) {
        if (!(err instanceof RefusedObject)) throw err;
        // Not sent and not skipped: the file stays at this offset, and every
        // pass reports it held until something changes.
        report.held.push({ path: src.path, reason: err.message });
        break;
      }
      report.uploaded.push({ key, bytes: chunk.length });
      const usage = src.kind === 'transcript' && opts.keys.usage ? usageLines(chunk) : '';
      if (usage && opts.keys.usage) {
        await opts.store.put(
          `${opts.host}/usage/${tail}`,
          seal(Buffer.from(usage), opts.keys.usage),
        );
      }
      const group = `${kind}\0${rec.folder}\0${src.name}\0${rec.gen}`;
      const entry = pending.files[group] ?? {
        kind,
        folder: rec.folder,
        name: src.name,
        gen: rec.gen,
        chunks: [],
      };
      entry.chunks.push({ key, offset: rec.sent, bytes: chunk.length, sha256: sha256(chunk) });
      pending.files[group] = entry;
      const sent = rec.sent + chunk.length;
      rec = { ...rec, sent, tail: tailHash(src.path, sent) };
      state.files[src.path] = rec;
      saveState(opts.statePath, state);
    }
  }
  if (pending.day !== today) {
    for (const f of Object.values(pending.files)) {
      const m: Manifest = { version: 1, host: opts.host, day: pending.day, ...f };
      const key = manifestKey(m);
      await opts.store.put(
        key,
        seal(Buffer.from(JSON.stringify(m)), [opts.keys.review, opts.keys.owner]),
      );
      report.uploaded.push({ key, bytes: 0 });
    }
    state.pending = { day: today, files: {} };
  }
  saveState(opts.statePath, state);
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
