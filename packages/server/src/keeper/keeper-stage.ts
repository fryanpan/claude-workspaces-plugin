/**
 * Copies of the local paths a `fly` call reads, made just before it runs.
 *
 * `keeper-paths.ts` refuses a path that resolves into the keeper's folders,
 * but the folder an agent names stays the agent's: between that check and
 * `fly` opening it, the agent can swap the folder, or a file in it, for a
 * link into the keeper's store. So `fly` never reads the agent's folder. The
 * keeper copies it into a folder of its own and hands `fly` the copy.
 *
 * What makes the copy safe is one check on each file as it is actually
 * opened: a file owned by the keeper's user is refused. Every file in the
 * store and the keeper's home is the keeper's; every file an agent made is
 * the agent's. A link is copied as a link, as `fly` would archive it, and
 * never followed. A folder swapped for a link mid-walk is followed, and every
 * file under it is the keeper's, so the copy stops there.
 *
 * A file `fly` opens by name (`--config`, `--dockerfile`) must be a plain
 * file in the copy, never a link. One inside the build folder is taken from
 * the folder's copy, so a `Dockerfile.dockerignore` beside it still applies.
 */
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';

/** A build folder bigger than this is refused rather than copied. */
export const MAX_STAGE_BYTES = 512 * 1024 * 1024;
const MAX_STAGE_FILES = 100_000;

export interface Staged {
  args: string[];
  /** Removes the copies. */
  done(): void;
}

/**
 * Copy the local path at each index of `args` and point the argv at the
 * copy. `keeperUid` is the user whose files may not be read.
 */
export function stageFlyPaths(
  args: readonly string[],
  at: readonly number[],
  keeperUid: number,
  root: string = tmpdir(),
): Staged {
  const into = mkdtempSync(join(root, 'keeper-stage-'));
  const budget = { bytes: MAX_STAGE_BYTES, files: MAX_STAGE_FILES };
  try {
    const out = [...args];
    const parts = at.map((i) => {
      const a = args[i] as string;
      const eq = a.startsWith('-') ? a.indexOf('=') + 1 : 0;
      return { i, flag: a.slice(0, eq), src: a.slice(eq) };
    });
    const copied: { src: string; dest: string }[] = [];
    // Folders first, so a file inside one is taken from its copy.
    const folders = parts.filter((p) => lstatSync(p.src).isDirectory());
    for (const [n, p] of folders.entries()) {
      const dest = join(into, String(n), basename(p.src));
      mkdirSync(join(into, String(n)));
      copy(p.src, dest, keeperUid, budget);
      copied.push({ src: p.src, dest });
      out[p.i] = `${p.flag}${dest}`;
    }
    for (const [n, p] of parts.entries()) {
      if (folders.includes(p)) continue;
      const home = copied.find((c) => p.src.startsWith(`${c.src}${sep}`));
      let dest: string;
      if (home) dest = join(home.dest, relative(home.src, p.src));
      else {
        mkdirSync(join(into, `f${n}`));
        dest = join(into, `f${n}`, basename(p.src));
        copy(p.src, dest, keeperUid, budget);
      }
      if (!lstatSync(dest).isFile()) throw new Error(`refused: ${p.src} is not a plain file`);
      out[p.i] = `${p.flag}${dest}`;
    }
    return { args: out, done: () => rmSync(into, { recursive: true, force: true }) };
  } catch (err) {
    rmSync(into, { recursive: true, force: true });
    throw err;
  }
}

function copy(
  src: string,
  dest: string,
  keeperUid: number,
  budget: { bytes: number; files: number },
): void {
  if (--budget.files < 0) throw new Error('the build folder holds too many files');
  const st = lstatSync(src);
  if (st.uid === keeperUid) throw new Error(`refused: ${src} belongs to the keeper`);
  if (st.isSymbolicLink()) {
    symlinkSync(readlinkSync(src), dest);
    return;
  }
  if (st.isDirectory()) {
    mkdirSync(dest, { mode: 0o700 });
    for (const name of readdirSync(src)) copy(join(src, name), join(dest, name), keeperUid, budget);
    return;
  }
  if (!st.isFile()) return;
  const { bytes, mode } = readPlainFile(src, keeperUid, budget.bytes);
  budget.bytes -= bytes.length;
  writeFileSync(dest, bytes, { mode: mode & 0o755 });
}

/**
 * One plain file's bytes, checked as opened: not a link, not the keeper's
 * own, not over `max` bytes. Opened without blocking, so a FIFO swapped in
 * for the file cannot stall the keeper's one thread; `fstat` then refuses it.
 */
export function readPlainFile(
  path: string,
  keeperUid: number,
  max: number,
): { bytes: Buffer; mode: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // The check that holds: the file as opened, not the path as looked up.
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`refused: ${path} is not a plain file`);
    if (opened.uid === keeperUid) throw new Error(`refused: ${path} belongs to the keeper`);
    if (opened.size > max) throw new Error(`refused: ${path} is too large`);
    const buf = Buffer.alloc(opened.size);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return { bytes: buf.subarray(0, read), mode: opened.mode };
  } finally {
    closeSync(fd);
  }
}
