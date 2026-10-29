import { randomBytes } from 'node:crypto';
import {
  constants,
  closeSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

/**
 * Where a pasted, dropped or picked image is kept: `images/` beside the
 * bound `.md`, under a name nothing else holds.
 *
 * A folder rather than the `.md`'s own directory, because a doc folder is
 * usually a repo directory full of other docs: one subfolder keeps the
 * pasted files together where a person can find and prune them, and
 * `![](images/x.png)` is the spelling GitHub renders and most markdown
 * guides use. The read route (`routes/doc-assets.ts`) serves it unchanged.
 */
export const IMAGE_FOLDER = 'images';

/**
 * 10 MB. A full-screen retina screenshot is 2–8 MB as PNG and a phone photo
 * 3–5 MB as JPEG, so a person's paste fits; the file usually lands in a git
 * repo, where anything much larger is a cost every clone pays.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImageExt = '.png' | '.jpg' | '.gif' | '.webp';

/**
 * The type the BYTES say, never the header or the name. Raster types only:
 * an SVG is a document that can carry script, and nothing a paste produces
 * needs it.
 */
export function sniffImage(b: Uint8Array): ImageExt | null {
  const at = (i: number, ...want: number[]) => want.every((v, k) => b[i + k] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return '.png';
  if (at(0, 0xff, 0xd8, 0xff)) return '.jpg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return '.gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return '.webp';
  return null;
}

/** A readable stem of the name a browser gave the file: no path, no extension. */
export function imageStem(name: string | null | undefined): string {
  const base = (name ?? '').split(/[/\\]/).pop() ?? '';
  const stem = base
    .replace(/\.[^.]*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return stem === '' ? 'image' : stem;
}

export type StoreResult =
  | { ok: true; src: string }
  | { ok: false; reason: 'not-a-folder' | 'outside' | 'no-free-name' };

const ATTEMPTS = 8;

/**
 * Write `bytes` to `images/<stem>-<suffix><ext>` beside `mdPath`.
 *
 * `wx` is what makes it never overwrite: the create fails if ANY entry holds
 * the name, a dangling symlink included, and the next suffix is tried. The
 * folder must be a real directory at its own path — a symlinked `images/`
 * is refused, so nothing is written outside the doc's tree.
 *
 * Under a walled lead's root (`lands`, from `boundFiles.guards.landsFor`),
 * the doc's folder is judged before anything is made in it, the file is
 * created `O_EXCL|O_NOFOLLOW` and judged again by where the descriptor
 * really is before a byte goes in, so a folder swapped for a link on the
 * way creates nothing outside; refused, only that new file is removed.
 */
/** Made new, never through a link at its name. */
const CREATE_FLAGS = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export function storeImageBeside(
  mdPath: string,
  bytes: Uint8Array,
  ext: ImageExt,
  stem: string,
  suffix: () => string = () => randomBytes(4).toString('hex'),
  lands: ((real: string) => boolean) | null = null,
): StoreResult {
  const docDir = realpathSync(dirname(mdPath));
  if (lands && !lands(docDir)) return { ok: false, reason: 'outside' };
  const folder = join(docDir, IMAGE_FOLDER);
  try {
    mkdirSync(folder, { recursive: true });
  } catch {
    return { ok: false, reason: 'not-a-folder' };
  }
  if (realpathSync(folder) !== folder) return { ok: false, reason: 'outside' };
  for (let i = 0; i < ATTEMPTS; i++) {
    const name = `${stem}-${suffix()}${ext}`;
    let fd: number;
    const path = join(folder, name);
    try {
      // Read-write: /dev/fd/<n> refuses an lstat on a write-only descriptor.
      fd = openSync(path, CREATE_FLAGS, 0o644);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    let refused = false;
    try {
      refused = lands !== null && !lands(realpathSync(`/dev/fd/${fd}`));
      if (!refused) writeSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    if (refused) {
      try {
        unlinkSync(path);
      } catch {}
      return { ok: false, reason: 'outside' };
    }
    return { ok: true, src: `${IMAGE_FOLDER}/${name}` };
  }
  return { ok: false, reason: 'no-free-name' };
}

/** What the assets route serves beside a doc, by extension. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** Each segment decoded alone, or null when any of them could climb out. */
export function decodeSegments(raw: string): string[] | null {
  const parts = raw.split('/');
  const out: string[] = [];
  for (const part of parts) {
    let seg: string;
    try {
      seg = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (seg.includes('/') || seg.includes('\\') || seg.includes('\0')) return null;
    out.push(seg);
  }
  return out.length > 0 ? out : null;
}

/** The real path of `segments` under `root`, or null when it is outside or not a file. */
export function resolveInside(root: string, segments: string[]): string | null {
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(join(realRoot, ...segments));
  } catch {
    return null;
  }
  if (!real.startsWith(realRoot + sep)) return null;
  try {
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}
