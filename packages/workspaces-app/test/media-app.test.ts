// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMediaDoc, mountMedia } from '../src/media/media-app.ts';
import type { MountContext } from '../src/mount-context.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * A folder's video opens on a page with a player that a phone will play
 * inline, pointed at the set's raw route; an image opens as an image; every
 * other file still opens as code.
 */

// The sidebar opens a stream a tick after each mount, past any per-test stub,
// so the stand-in is installed for the whole file. happy-dom has none.
(globalThis as { EventSource?: unknown }).EventSource ??= class {
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
};

function ctxFor(relPath: string, scope: MountScope): MountContext {
  return {
    docId: `set-1:${relPath}`,
    docType: 'code',
    sourceUrl: '',
    workspaceId: 'set-1',
    relPath,
    diffTarget: '',
    scope,
    client: {} as MountContext['client'],
    user: { id: 'u', name: 'Harborlight', color: '#000' } as MountContext['user'],
    canWrite: true,
  };
}

beforeEach(() => {
  history.replaceState(null, '', '/workspaces/w-1/docs/set-1%3Aclips%2Fwalk.mp4');
  document.body.className = '';
  document.body.innerHTML =
    '<span id="doc-title"></span><div id="set-pane-list"></div><div id="editor"></div>';
  // The sidebar's fetches have nothing to answer here; the player does not wait on them.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isMediaDoc', () => {
  it('picks a set member by its extension, and nothing else', () => {
    const at = (relPath: string, docType: MountContext['docType'] = 'code', workspaceId = 's') =>
      isMediaDoc({ relPath, docType, workspaceId });
    expect(at('clips/walk.mp4')).toBe(true);
    expect(at('take.MOV')).toBe(true);
    expect(at('take.webm')).toBe(true);
    expect(at('chart.png')).toBe(true);
    expect(at('src/app.ts')).toBe(false);
    // A diff member is the diff viewer's, and a doc on no set has no raw route.
    expect(at('clips/walk.mp4', 'diff')).toBe(false);
    expect(at('clips/walk.mp4', 'code', '')).toBe(false);
  });
});

describe('mountMedia', () => {
  it('plays a video inline from the set’s raw route', () => {
    const scope = new MountScope();
    mountMedia(ctxFor('clips/walk.mp4', scope));
    const video = document.querySelector<HTMLVideoElement>('#editor video');
    expect(video).not.toBeNull();
    expect(video?.controls).toBe(true);
    expect(video?.hasAttribute('playsinline')).toBe(true);
    const source = video?.querySelector('source');
    expect(source?.getAttribute('type')).toBe('video/mp4');
    expect(source?.getAttribute('src')).toBe(
      '/workspaces/w-1/attachments/set-1/raw?path=clips%2Fwalk.mp4',
    );
    expect(document.body.classList.contains('media-mode')).toBe(true);
    expect(document.getElementById('doc-title')?.title).toBe('clips/walk.mp4');
    scope.dispose();
    expect(video?.querySelector('source')).toBeNull();
  });

  it('shows an image as an image', () => {
    mountMedia(ctxFor('chart.png', new MountScope()));
    const img = document.querySelector<HTMLImageElement>('#editor img');
    expect(img?.getAttribute('src')).toBe('/workspaces/w-1/attachments/set-1/raw?path=chart.png');
    expect(img?.alt).toBe('chart.png');
    expect(document.querySelector('#editor video')).toBeNull();
  });
});
