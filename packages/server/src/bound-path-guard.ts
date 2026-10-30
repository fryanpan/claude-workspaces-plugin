/**
 * The guarded half of the bound-file reader (`slow-fs.ts` `boundFiles.guards`):
 * the rule a guard answers to, and the reads and writes asked through it.
 *
 * A path a guard holds to a walled lead's root goes through `tree-fs.ts`,
 * which never follows a link below the root. Any other covered path (the
 * owner's part of `~/.claude`), and every covered path off macOS, goes
 * through the plain-path checks of `bound-path-checked.ts`.
 */
import type { BigIntStats, Stats } from 'node:fs';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { realpathSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  GUARDED_TEXT_MAX,
  UTF8,
  nearestRealpathSync,
  openCheckedSync,
  readChecked,
  readCheckedSync,
  readRangeChecked,
  statChecked,
  writeChecked,
  writeCheckedSync,
} from './bound-path-checked.ts';
import { stampOf } from './file-stamp.ts';
import { GuardRefused } from './guard-refused.ts';
import {
  type Contained,
  mkdirTreeSync,
  readTree,
  readTreeRangeSync,
  readTreeSync,
  statTree,
  statTreeSync,
  treeFsMode,
  writeTree,
  writeTreeSync,
} from './tree-fs.ts';

export {
  GUARDED_TEXT_MAX,
  isEnoent,
  nearestRealpathSync,
  readBytesChecked,
  readChecked,
  readCheckedSync,
  readRangeChecked,
  writeChecked,
  writeCheckedSync,
} from './bound-path-checked.ts';
export { GuardRefused, redactBoundPath } from './guard-refused.ts';

/**
 * A rule for the bound files under some folders (`PathGuards`). `covers`
 * says whether a path is its business; `admits` is asked on the main thread
 * and must be cheap; `landsInside` is asked with where the path really is,
 * resolved off the main thread.
 */
export interface PathGuard {
  covers(path: string): boolean;
  admits(path: string): boolean;
  landsInside(path: string, real: string): boolean;
  /** Whether a folder it guards sits at or below `dir`, for a caller that
   *  must not act on anything holding one (`git-hardening.ts`). */
  holdsRoot?(dir: string): boolean;
  /** The root that holds `path`, and `path` as the root is spelled, for
   *  the contained calls (`tree-fs.ts`); null for a covered path no root
   *  holds. */
  containedOf?(path: string): Contained | null;
}

/**
 * The guards installed on the bound-file reader, asked together. A guard
 * holds every bound file under its folders, whoever bound it and for
 * whichever set.
 */
export class PathGuards {
  private readonly set = new Set<PathGuard>();

  add(guard: PathGuard): () => void {
    this.set.add(guard);
    return () => {
      this.set.delete(guard);
    };
  }

  allows(path: string): boolean {
    for (const guard of this.set) if (!guard.admits(path)) return false;
    return true;
  }

  covers(path: string): boolean {
    for (const guard of this.set) if (guard.covers(path)) return true;
    return false;
  }

  holdsRoot(dir: string): boolean {
    for (const guard of this.set) if (guard.holdsRoot?.(dir)) return true;
    return false;
  }

  /**
   * `path` as a root holds it, for `tree-fs.ts`; null for the plain checks
   * (no root holds it, or this is not macOS). On macOS without the
   * contained calls, `tree-fs.ts` refuses every such path itself.
   */
  private tree(path: string): Contained | null {
    if (treeFsMode() === 'legacy') return null;
    for (const guard of this.set) {
      const c = guard.containedOf?.(path);
      if (c) return c;
    }
    return null;
  }

  /** `path` as a root holds it, for a caller that lists or reads it
   *  through `tree-fs.ts` itself; null for a path no root holds, or off
   *  macOS. Throws `GuardRefused` as the reads here do. */
  containedOf(path: string): Contained | null {
    return this.covers(path) ? this.tree(path) : null;
  }

  private landsAll(path: string, real: string): boolean {
    for (const guard of this.set) if (!guard.landsInside(path, real)) return false;
    return true;
  }

  landsAllowedSync(path: string): boolean {
    if (!this.allows(path)) return false;
    if (!this.covers(path)) return true;
    const real = nearestRealpathSync(path);
    return real !== null && this.landsAll(path, real);
  }

  /** The check a covered path's real location must pass, for a caller
   *  doing its own guarded open; null when no guard covers it. Throws
   *  `GuardRefused` when a guard refuses the path outright. */
  landsFor(path: string): ((real: string) => boolean) | null {
    if (!this.covers(path)) return null;
    if (!this.allows(path)) throw new GuardRefused(path);
    return (real) => this.landsAll(path, real);
  }

  /** Read a bound file, checked where a guard covers it. */
  async read(path: string): ReturnType<typeof readChecked> {
    if (!this.allows(path)) throw new GuardRefused(path);
    const c = this.containedOf(path);
    if (c) {
      const got = await readTree(c, GUARDED_TEXT_MAX);
      if (got === 'too-large') throw new GuardRefused(path, 'it is too large to be a doc');
      return { text: UTF8.decode(got.bytes), ...stampOf(got.st) };
    }
    const lands = (real: string) => this.landsAll(path, real);
    return readChecked(path, this.covers(path) ? lands : null);
  }

  /** A byte range of a covered file, judged as `read` judges one; null
   *  when no guard covers it, for the caller's own unguarded read. */
  readRange(path: string, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> | null {
    if (!this.covers(path)) return null;
    if (!this.allows(path)) return Promise.reject(new GuardRefused(path));
    const c = this.tree(path);
    if (c) return Promise.resolve().then(() => readTreeRangeSync(c, start, end));
    return readRangeChecked(path, start, end, (real) => this.landsAll(path, real));
  }

  /** A bound file's stat, from a checked descriptor where a guard covers it:
   *  a plain stat follows a link and reports what it points at. */
  stat(path: string): Promise<BigIntStats> {
    if (!this.allows(path)) return Promise.reject(new GuardRefused(path));
    if (!this.covers(path)) return stat(path, { bigint: true });
    const c = this.tree(path);
    if (c) return statTree(c);
    return statChecked(path, (real) => this.landsAll(path, real));
  }

  /** `stat` on the calling thread; throws as `statSync` does, and `GuardRefused`. */
  statSync(path: string): Stats {
    if (!this.allows(path)) throw new GuardRefused(path);
    if (!this.covers(path)) return statSync(path);
    const c = this.tree(path);
    if (c) return statTreeSync(c);
    const fd = openCheckedSync(path, (real) => this.landsAll(path, real));
    try {
      return fstatSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** At most `max` bytes of a bound file's text on the calling thread, or
   *  `'too-large'`: never blocking on a FIFO, and checked where a guard
   *  covers it. Throws as `readFileSync` does, and `GuardRefused`. */
  readBoundedSync(path: string, max: number): string | 'too-large' {
    const bytes = this.readBoundedBytesSync(path, max);
    return bytes === 'too-large' ? bytes : UTF8.decode(bytes);
  }

  /** `readBoundedSync`, as bytes. */
  readBoundedBytesSync(path: string, max: number): Uint8Array<ArrayBuffer> | 'too-large' {
    if (!this.allows(path)) throw new GuardRefused(path);
    const c = this.containedOf(path);
    if (c) return readTreeSync(c, max);
    const fd = this.covers(path)
      ? openCheckedSync(path, (real) => this.landsAll(path, real))
      : openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new GuardRefused(path);
      if (st.size > max) return 'too-large';
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** `read` on the calling thread; throws `GuardRefused` where a guard
   *  refuses the path. */
  readSync(path: string): string {
    if (!this.allows(path)) throw new GuardRefused(path);
    const c = this.containedOf(path);
    if (c) {
      const got = readTreeSync(c, GUARDED_TEXT_MAX);
      if (got === 'too-large') throw new GuardRefused(path, 'it is too large to be a doc');
      return UTF8.decode(got);
    }
    const lands = (real: string) => this.landsAll(path, real);
    return readCheckedSync(path, this.covers(path) ? lands : null);
  }

  /**
   * `mkdir -p` for a covered folder, one folder at a time: the folder it
   * is made in is judged first, and each new folder after, so a link on the
   * way stops the walk rather than carrying it outside. Uncovered folders
   * are made as `mkdirSync` makes them.
   */
  mkdirSync(dir: string): void {
    if (!this.covers(dir)) {
      mkdirSync(dir, { recursive: true });
      return;
    }
    if (!this.allows(dir)) throw new GuardRefused(dir);
    const c = this.tree(dir);
    if (c) {
      mkdirTreeSync(c);
      return;
    }
    const lands = (real: string) => this.landsAll(dir, real);
    const missing: string[] = [];
    let at = dir;
    for (;;) {
      let exists = true;
      try {
        lstatSync(at);
      } catch {
        exists = false;
      }
      if (exists) break;
      missing.unshift(at);
      const up = dirname(at);
      if (up === at) break;
      at = up;
    }
    if (!lands(realpathSync(at))) throw new GuardRefused(dir);
    for (const folder of missing) {
      try {
        mkdirSync(folder);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      if (!lands(realpathSync(folder))) throw new GuardRefused(dir);
    }
  }

  /** `write` on the calling thread, through `lane`'s own temp file. */
  writeSync(path: string, text: string, lane: 'flush' | 'export'): void {
    if (!this.allows(path)) throw new GuardRefused(path);
    const c = this.containedOf(path);
    if (c) {
      writeTreeSync(c, Buffer.from(text, 'utf8'), lane);
      return;
    }
    const lands = (real: string) => this.landsAll(path, real);
    writeCheckedSync(path, text, lane, this.covers(path) ? lands : null);
  }

  /** Write a bound file, checked where a guard covers it. */
  async write(path: string, text: string): Promise<BigIntStats> {
    if (!this.allows(path)) throw new GuardRefused(path);
    const c = this.containedOf(path);
    if (c) return writeTree(c, text, 'pool-write');
    const lands = (real: string) => this.landsAll(path, real);
    return writeChecked(path, text, this.covers(path) ? lands : null);
  }
}
