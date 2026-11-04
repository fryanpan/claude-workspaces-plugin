/**
 * The bound-file guards, as the helpers that sit below them see them.
 *
 * A helper such as `readLine` or `statStampSync` can be called by any module
 * without going through `PathGuards`, so each one asks here whether the path
 * is under a walled lead's root and refuses it itself
 * (docs/architecture/lead-tree-containment.md, "The helpers fail closed").
 * `slow-fs.ts` installs the server's guards at load. This module imports
 * nothing, so every helper can import it without making a cycle.
 */
import type { BigIntStats } from 'node:fs';

export interface RootView {
  /** A guard covers the path: a root, a shadow, or every path while the
   *  roots file cannot be read. */
  covers(path: string): boolean;
  /** A registered root holds the path, on every platform. */
  heldByRoot(path: string): boolean;
  /** The path's stat, through the guards. */
  statBigSync(path: string): BigIntStats;
}

let view: RootView | null = null;

export function setRootView(v: RootView | null): void {
  view = v;
}

/** The installed view; null in a process that installed none (a script). */
export function rootView(): RootView | null {
  return view;
}
