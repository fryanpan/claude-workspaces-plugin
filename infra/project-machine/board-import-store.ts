/**
 * A board pushed to a project machine over HTTPS, and the import its next
 * boot makes. `push-board.ts` is the sending half; `routes/board-import.ts`
 * in the server receives it; `board-import-cli.ts apply` runs from
 * `entrypoint.sh` before the server starts.
 *
 *   <root>/restart               present: the machine restarts to import
 *   <root>/<board>/status.json   staged | importing | imported | refused
 *   <root>/<board>/incoming/     the received bundle, until the boot imports it
 *
 * The wire format is one JSON line, then each listed file's bytes in the
 * manifest's order, with no separators:
 *
 *   {"format":"cw-board-push-1","manifest":<BoardManifest>}\n<bytes>…
 *
 * It is read as hostile. Each path is checked before anything is written,
 * each file is written new into a fresh folder, and `readBundle` then
 * checks every hash, path and shared entry, exactly as `machine:move-board`
 * checks an upload. No tar runs on it.
 *
 * The import is idempotent. A board the data dir holds is refused, a board
 * already staged is refused, and `importBoard` itself refuses to write over
 * any file. A second push or a second boot never overwrites an edit made on
 * the machine since. A crash between the import and its status line is
 * read back as imported, because `importing` is written first.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BOARD_ID,
  type BoardManifest,
  MoveRefused,
  holdsBoard,
  importBoard,
  readBundle,
} from './board-bundle.ts';

export const PUSH_FORMAT = 'cw-board-push-1';
/** The largest push the machine takes: Bun's default request body limit. */
export const MAX_PUSH_BYTES = 128 * 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024 * 1024;
const COPY_CHUNK = 1024 * 1024;

export type ImportState = 'none' | 'staged' | 'importing' | 'imported' | 'refused';

export interface ImportStatus {
  state: ImportState;
  /** Whether the machine's data dir holds the board now. */
  holds: boolean;
  /** SHA-256 of the push that was staged. */
  sha256?: string;
  files?: number;
  reason?: string;
  at?: string;
}

/** Where pushes are received and which boards this machine takes. */
export interface ImportPlace {
  root: string;
  dataDir: string;
  /** The board ids this machine is for. Any other is refused. */
  boards: readonly string[];
}

const boardDir = (root: string, board: string) => join(root, board);
const statusPath = (root: string, board: string) => join(boardDir(root, board), 'status.json');
export const restartMarker = (root: string): string => join(root, 'restart');

function readStatus(root: string, board: string): Omit<ImportStatus, 'holds'> {
  try {
    const s = JSON.parse(readFileSync(statusPath(root, board), 'utf8')) as ImportStatus;
    return typeof s.state === 'string' ? s : { state: 'none' };
  } catch {
    return { state: 'none' };
  }
}

function writeStatus(root: string, board: string, s: Omit<ImportStatus, 'holds'>): void {
  const path = statusPath(root, board);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...s, at: new Date().toISOString() })}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, path);
}

export function importStatus(place: ImportPlace, board: string): ImportStatus {
  return { ...readStatus(place.root, board), holds: holdsBoard(place.dataDir, board) };
}

/** Throws unless this machine takes `board`. */
export function checkBoard(place: ImportPlace, board: string): void {
  if (!BOARD_ID.test(board)) throw new MoveRefused(`not a board id: ${board}`);
  if (!place.boards.includes(board)) {
    throw new MoveRefused(`this machine does not take board ${board}`);
  }
}

/** A manifest path that stays inside the folder it is written under. */
function safeRelPath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024)
    throw new MoveRefused('a pushed path is malformed');
  const parts = path.split('/');
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    parts.some((p) => p === '' || p === '.' || p === '..')
  ) {
    throw new MoveRefused(`a pushed path escapes its folder: ${path}`);
  }
  return path;
}

/** Writes the push body for an exported bundle to `out`. Bindings never leave the Mac. */
export function writePushBody(bundleDir: string, manifest: BoardManifest, out: string): string {
  const sent: BoardManifest = { ...manifest, bindings: [] };
  const fd = openSync(out, 'wx', 0o600);
  const hash = createHash('sha256');
  const put = (b: Uint8Array) => {
    writeSync(fd, b);
    hash.update(b);
  };
  try {
    put(Buffer.from(`${JSON.stringify({ format: PUSH_FORMAT, manifest: sent })}\n`, 'utf8'));
    for (const f of sent.files) put(readFileSync(join(bundleDir, 'files', safeRelPath(f.path))));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** Streams a request body to `path`, refusing more than `max` bytes. */
async function spool(body: ReadableStream<Uint8Array>, path: string, max: number) {
  const fd = openSync(path, 'wx', 0o600);
  const hash = createHash('sha256');
  let n = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) throw new MoveRefused(`the push is over ${max} bytes`);
      writeSync(fd, value);
      hash.update(value);
    }
  } finally {
    closeSync(fd);
    reader.releaseLock();
  }
  return { bytes: n, sha256: hash.digest('hex') };
}

/** The header line of a spooled push, and the offset its file bytes start at. */
function readHeader(path: string): { manifest: BoardManifest; offset: number } {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(MAX_HEADER_BYTES, statSync(path).size));
    const got = readSync(fd, buf, 0, buf.length, 0);
    const end = buf.subarray(0, got).indexOf(0x0a);
    if (end < 0) throw new MoveRefused('the push has no header line');
    let header: { format?: unknown; manifest?: unknown };
    try {
      header = JSON.parse(buf.subarray(0, end).toString('utf8'));
    } catch {
      throw new MoveRefused('the push header is not JSON');
    }
    if (header.format !== PUSH_FORMAT) throw new MoveRefused('not a board push');
    const m = header.manifest as BoardManifest | undefined;
    if (!m || typeof m !== 'object' || !Array.isArray(m.files))
      throw new MoveRefused('the push has no manifest');
    return { manifest: m, offset: end + 1 };
  } finally {
    closeSync(fd);
  }
}

/** Copies `len` bytes at `offset` of `src` into a new file `dest`. */
function copyRange(srcFd: number, offset: number, len: number, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const out = openSync(dest, 'wx', 0o600);
  try {
    const buf = Buffer.alloc(Math.min(COPY_CHUNK, Math.max(len, 1)));
    let done = 0;
    while (done < len) {
      const got = readSync(srcFd, buf, 0, Math.min(buf.length, len - done), offset + done);
      if (got <= 0) throw new MoveRefused('the push ended early');
      writeSync(out, buf.subarray(0, got));
      done += got;
    }
  } finally {
    closeSync(out);
  }
}

/** Turns a spooled push into a bundle folder `readBundle` can check. */
function unpackPush(
  spooled: string,
  size: number,
  bundleDir: string,
  board: string,
): BoardManifest {
  const { manifest, offset } = readHeader(spooled);
  if (manifest.boardId !== board)
    throw new MoveRefused(`the push holds ${String(manifest.boardId)}, not ${board}`);
  const sizes = manifest.files.map((f) => {
    if (!Number.isSafeInteger(f?.bytes) || f.bytes < 0)
      throw new MoveRefused('a pushed file size is malformed');
    return f.bytes;
  });
  if (offset + sizes.reduce((a, b) => a + b, 0) !== size)
    throw new MoveRefused('the push is not the length its manifest says');
  const paths = manifest.files.map((f) => safeRelPath(f.path));
  if (new Set(paths).size !== paths.length) throw new MoveRefused('the push lists a path twice');
  mkdirSync(join(bundleDir, 'files'), { recursive: true, mode: 0o700 });
  const fd = openSync(spooled, 'r');
  try {
    let at = offset;
    paths.forEach((p, i) => {
      const len = sizes[i] ?? 0;
      copyRange(fd, at, len, join(bundleDir, 'files', p));
      at += len;
    });
  } finally {
    closeSync(fd);
  }
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return readBundle(bundleDir);
}

/**
 * Receives one push for `board`, checks it, and stages it for the next boot.
 * Throws `MoveRefused`, having staged nothing, when this machine does not
 * take the board, already holds or has staged it, or the push fails a check.
 */
export async function receivePush(
  place: ImportPlace,
  board: string,
  body: ReadableStream<Uint8Array>,
  max: number = MAX_PUSH_BYTES,
): Promise<ImportStatus> {
  checkBoard(place, board);
  if (holdsBoard(place.dataDir, board)) {
    throw new MoveRefused(`this machine already holds board ${board}; nothing was changed`);
  }
  const prior = readStatus(place.root, board).state;
  if (prior === 'staged' || prior === 'importing') {
    throw new MoveRefused(`board ${board} is already ${prior}; it imports at the next boot`);
  }
  const dir = boardDir(place.root, board);
  const incoming = join(dir, 'incoming');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A partial push is transient: removing it destroys nothing anyone made.
  rmSync(incoming, { recursive: true, force: true });
  mkdirSync(incoming, { mode: 0o700 });
  try {
    const spooled = join(incoming, 'push.bin');
    const { bytes, sha256 } = await spool(body, spooled, max);
    const m = unpackPush(spooled, bytes, join(incoming, 'bundle'), board);
    rmSync(spooled, { force: true });
    writeStatus(place.root, board, { state: 'staged', sha256, files: m.files.length });
    writeFileSync(restartMarker(place.root), '', { mode: 0o600 });
    return importStatus(place, board);
  } catch (e) {
    rmSync(incoming, { recursive: true, force: true });
    const reason = e instanceof Error ? e.message : String(e);
    writeStatus(place.root, board, { state: 'refused', reason });
    throw e instanceof MoveRefused ? e : new MoveRefused(reason);
  }
}

/**
 * At boot, before the server starts: imports every staged push into the data
 * dir. Returns one log line per board it looked at.
 */
export function applyStaged(place: ImportPlace): string[] {
  rmSync(restartMarker(place.root), { force: true });
  if (!existsSync(place.root)) return [];
  const log: string[] = [];
  for (const board of readdirSync(place.root)) {
    if (!BOARD_ID.test(board)) continue;
    const s = readStatus(place.root, board);
    const incoming = join(boardDir(place.root, board), 'incoming');
    if (s.state === 'importing') {
      // The last boot stopped inside the import; what it left is the answer.
      const held = holdsBoard(place.dataDir, board);
      writeStatus(
        place.root,
        board,
        held
          ? { ...s, state: 'imported' }
          : { ...s, state: 'refused', reason: 'the import stopped part way' },
      );
      rmSync(incoming, { recursive: true, force: true });
      log.push(`board ${board}: an interrupted import reads as ${held ? 'imported' : 'refused'}`);
      continue;
    }
    if (s.state !== 'staged') continue;
    try {
      checkBoard(place, board);
      writeStatus(place.root, board, { ...s, state: 'importing' });
      const m = importBoard(join(incoming, 'bundle'), place.dataDir, board);
      writeStatus(place.root, board, { ...s, state: 'imported', files: m.files.length });
      log.push(`board ${board}: imported ${m.files.length} file(s)`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      writeStatus(place.root, board, { ...s, state: 'refused', reason });
      log.push(`board ${board}: refused: ${reason}`);
    } finally {
      rmSync(incoming, { recursive: true, force: true });
    }
  }
  return log;
}

/** `CW_BOARD_IMPORT_BOARDS`: a comma-separated list of board ids. Malformed ids are dropped. */
export function parseImportBoards(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => BOARD_ID.test(s));
}
