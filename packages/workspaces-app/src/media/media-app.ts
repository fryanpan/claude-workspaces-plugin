import { mediaTypeOf } from '@claude-workspaces/core';
import { renderDiffNav, wireDiffNavRefresh } from '../diff-nav.ts';
import { api } from '../doc-path.ts';
import type { MountContext } from '../mount-context.ts';
import { renderWorkspaceTree, wireWorkspaceTreeRefresh } from '../workspace-tree.ts';

/**
 * A video or image in an attached folder, on its own page.
 *
 * The member is a `code` doc that holds no copy of the file (the server never
 * binds one), so this surface reads the bytes from the set's raw route, which
 * answers range requests: a phone's `<video>` asks for `bytes=0-1` before it
 * plays and for a range at every seek. `playsinline` keeps an iPhone from
 * taking the video full-screen the moment it starts.
 *
 * The sidebar is the same one the code surface shows, so the reader moves
 * between files without leaving the set.
 */

/** Whether this doc mounts as media rather than as code. */
export function isMediaDoc(
  ctx: Pick<MountContext, 'docType' | 'relPath' | 'workspaceId'>,
): boolean {
  return ctx.docType === 'code' && ctx.workspaceId !== '' && mediaTypeOf(ctx.relPath) !== undefined;
}

/** The address a set's file is streamed from. */
export function rawUrlFor(setId: string, relPath: string): string {
  return api(`attachments/${encodeURIComponent(setId)}/raw?path=${encodeURIComponent(relPath)}`);
}

export function mountMedia(ctx: MountContext): void {
  const { docId, scope, workspaceId, relPath } = ctx;
  void (async () => {
    const isDiffNav = await renderDiffNav(docId, workspaceId, false, scope);
    if (scope.disposed) return;
    if (isDiffNav) {
      scope.onCleanup(wireDiffNavRefresh(docId, workspaceId, scope));
    } else {
      void renderWorkspaceTree(docId, workspaceId, false, scope);
      scope.onCleanup(wireWorkspaceTreeRefresh(docId, workspaceId, scope));
    }
  })();
  document.body.classList.add('code-mode', 'media-mode');
  const editor = document.getElementById('editor');
  if (!editor) return;
  const type = mediaTypeOf(relPath) ?? '';
  const src = rawUrlFor(workspaceId, relPath);
  const name = relPath.split('/').pop() ?? relPath;
  const frame = document.createElement('figure');
  frame.className = 'media-view';
  if (type.startsWith('video/')) {
    const video = document.createElement('video');
    video.controls = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'metadata';
    const source = document.createElement('source');
    source.src = src;
    source.type = type;
    video.append(source);
    video.setAttribute('aria-label', name);
    frame.append(video);
    // Stop the download and the decoder when the reader navigates away.
    scope.onCleanup(() => {
      video.pause();
      video.removeAttribute('src');
      source.remove();
      video.load();
    });
  } else {
    const img = document.createElement('img');
    img.src = src;
    img.alt = name;
    frame.append(img);
  }
  editor.replaceChildren(frame);
}
