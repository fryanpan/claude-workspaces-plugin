/**
 * Two calls `tree-fs.ts` did not have: asking whether a name under a lead's
 * root is there, and creating a new file there. Both follow the rules in
 * `tree-fs.ts`'s header: every open names the whole path with
 * `O_NOFOLLOW_ANY`, every descriptor is judged, and nothing after the open
 * goes by path.
 */
import { closeSync, writeSync } from 'node:fs';
import { GuardRefused } from './guard-refused.ts';
import { SF_DATALESS } from './tree-fs-native.ts';
import { type Contained, namesOf, treeInternals as t } from './tree-fs.ts';

/**
 * Whether something is at `c`. A link anywhere on the path answers true,
 * whatever it points at, so the answer never says whether a file outside the
 * root exists; the read that follows refuses it. A missing name, or a missing
 * folder on the way, answers false. Throws `GuardRefused` when the root is
 * not the folder that was registered.
 */
export function existsTree(c: Contained): boolean {
  t.rootDev(c.root);
  namesOf(c);
  const flags = t.native(c.abs).flagsAt(c.abs);
  // A dataless file is there; opening it would wait for its download.
  if (flags !== null && (flags & SF_DATALESS) !== 0) return true;
  let fd: number;
  try {
    fd = t.openNoLink(c.abs, t.FILE_OPEN);
  } catch (err) {
    if (err instanceof GuardRefused) return true;
    const code = (err as NodeJS.ErrnoException).code;
    return !(code === 'ENOENT' || code === 'ENOTDIR');
  }
  closeSync(fd);
  return true;
}

/**
 * Create the file at `c` new, holding `bytes`: its folder is judged, the
 * file is opened `O_CREAT|O_EXCL|O_NOFOLLOW_ANY` and judged before a byte
 * goes in. Throws `EEXIST` when the name is taken (by anything, a link
 * included), and `GuardRefused` when the judged file is not where it was
 * asked; that file is then removed through the judged folder.
 */
export function createTree(c: Contained, bytes: Uint8Array, mode = 0o644): void {
  const n = t.native(c.abs);
  const dev = t.rootDev(c.root);
  const names = namesOf(c);
  const name = names.at(-1);
  if (name === undefined) throw new GuardRefused(c.abs, 'a root is not a file');
  const dir = names.length === 1 ? c.root : `${c.root}/${names.slice(0, -1).join('/')}`;
  const dirFd = t.openDir({ root: c.root, abs: dir }, dev);
  try {
    const fd = t.openNoLink(c.abs, t.TEMP_OPEN, mode);
    try {
      t.judge(fd, c, dev, 'file');
      let at = 0;
      while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
    } catch (err) {
      closeSync(fd);
      n.unlinkat(dirFd, name);
      throw err;
    }
    closeSync(fd);
  } finally {
    closeSync(dirFd);
  }
}
