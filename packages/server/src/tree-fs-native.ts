/**
 * The libc calls `tree-fs.ts` needs and node does not have, through
 * `bun:ffi`, on macOS only.
 *
 * Node has no call that works on a directory descriptor: no `mkdirat`, no
 * `unlinkat`, no `renameat`, and `readdirSync("/dev/fd/<n>")` fails with
 * ENOTDIR. A folder a walled lead can write is only safe to act in through a
 * descriptor that was opened with no link anywhere on its path, so these
 * four are the calls that make that possible. `lstat` is here for
 * `st_flags`, which node's `Stats` does not carry and which is the only
 * way to see that a file's bytes live in the cloud (`SF_DATALESS`).
 *
 * Measured on arm64 (scratch probe, 2026-10-30): `struct dirent` puts
 * `d_namlen` at 18, `d_type` at 20 and `d_name` at 21; `struct stat` puts
 * `st_flags` at 116. A variadic argument
 * arrives as garbage through FFI on arm64, so nothing variadic is bound here
 * (`openat`'s mode, `fcntl`): files are opened by node, by full path, with
 * `O_NOFOLLOW_ANY`, and handed in as descriptors.
 *
 * Every call answers an errno (0 for success) rather than throwing, so the
 * caller decides what a refusal means. Off darwin, or when the library will
 * not load, `treeNative()` is null and stays null.
 */
import type * as BunFfi from 'bun:ffi';

/** `d_type` of a link. */
export const DT_LNK = 10;
export const DT_DIR = 4;
export const DT_REG = 8;
/** `renameatx_np`'s flag: refuse a link in any component of either name. */
export const RENAME_NOFOLLOW_ANY = 0x10;
/** `st_flags`: the file's bytes are not on this disk. */
export const SF_DATALESS = 0x40000000;

const STAT_BYTES = 144;
const DIRENT_NAMLEN = 18;
const DIRENT_TYPE = 20;
const DIRENT_NAME = 21;
const STAT_FLAGS = 116;

export interface TreeEntry {
  name: string;
  /** `d_type`: `DT_DIR`, `DT_REG`, `DT_LNK`, or another kind. */
  type: number;
}

export interface TreeNative {
  /** Every entry of an open folder but `.` and `..`, at most `max`; null
   *  when there are more. Takes the descriptor: it is closed on return. */
  readdirFd(fd: number, max: number): TreeEntry[] | null;
  mkdirat(dirFd: number, name: string, mode: number): number;
  unlinkat(dirFd: number, name: string): number;
  /** `renameatx_np(dirFd, from, dirFd, to, RENAME_NOFOLLOW_ANY)`. */
  renameat(dirFd: number, from: string, to: string): number;
  /** `st_flags` of the name `path` (not followed when it is a link), or
   *  null when `lstat` failed. Asked BEFORE an open: with materialization on
   *  (`dataless-policy.ts`), opening a dataless file waits for its download. */
  flagsAt(path: string): number | null;
}

let loaded: TreeNative | null | undefined;

/** The calls, or null off darwin or when they cannot be loaded. */
export function treeNative(): TreeNative | null {
  if (loaded !== undefined) return loaded;
  loaded = process.platform === 'darwin' ? load() : null;
  return loaded;
}

function load(): TreeNative | null {
  try {
    // Required here rather than imported at the top: node-run tests import
    // the server's modules too, and `bun:ffi` does not resolve there.
    const { dlopen, FFIType, ptr, read, toArrayBuffer } = require('bun:ffi') as typeof BunFfi;
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
      readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
      closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
      mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.u16], returns: FFIType.i32 },
      unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      renameatx_np: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
        returns: FFIType.i32,
      },
      lstat: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    const s = lib.symbols;
    const errno = (): number => {
      const at = s.__error();
      return at === null ? -1 : read.i32(at, 0);
    };
    const c = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf8');
    const rc = (n: number): number => (n === 0 ? 0 : errno() || -1);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const statBuf = new Uint8Array(STAT_BYTES);
    const statView = new DataView(statBuf.buffer);
    return {
      readdirFd(fd, max) {
        const dir = s.fdopendir(fd);
        if (dir === null) throw Object.assign(new Error('fdopendir failed'), { errno: errno() });
        try {
          const out: TreeEntry[] = [];
          for (;;) {
            const e = s.readdir(dir);
            if (e === null) return out;
            const len = read.u16(e, DIRENT_NAMLEN);
            const name = decoder.decode(new Uint8Array(toArrayBuffer(e, DIRENT_NAME, len)));
            if (name === '.' || name === '..') continue;
            if (out.length >= max) return null;
            out.push({ name, type: read.u8(e, DIRENT_TYPE) });
          }
        } finally {
          s.closedir(dir);
        }
      },
      mkdirat: (dirFd, name, mode) => rc(s.mkdirat(dirFd, c(name), mode)),
      unlinkat: (dirFd, name) => rc(s.unlinkat(dirFd, c(name), 0)),
      renameat: (dirFd, from, to) =>
        rc(s.renameatx_np(dirFd, c(from), dirFd, c(to), RENAME_NOFOLLOW_ANY)),
      flagsAt(path) {
        if (s.lstat(c(path), ptr(statBuf)) !== 0) return null;
        return statView.getUint32(STAT_FLAGS, true);
      },
    };
  } catch (err) {
    console.error('[tree-fs] the native calls could not be loaded:', err);
    return null;
  }
}

/** For a test: forget the loaded calls, or put fakes in their place. */
export function setTreeNativeForTest(native: TreeNative | null | undefined): void {
  loaded = native;
}
