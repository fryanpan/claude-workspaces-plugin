import type { MountFn } from './mount-context.ts';

/**
 * Late-bound handle to the full markdown surface (mountMarkdown, in
 * doc/markdown-mount.ts). redline-app mounts it for the editable File view of
 * a `.md` diff member. app.ts registers a loader for it at boot, so the
 * redline chunk neither imports the editor's chunk nor forms a cycle with the
 * entry that lazy-loads both.
 */
let markdownMount: MountFn | null = null;

export function registerMarkdownMount(fn: MountFn): void {
  markdownMount = fn;
}

export function getMarkdownMount(): MountFn | null {
  return markdownMount;
}
