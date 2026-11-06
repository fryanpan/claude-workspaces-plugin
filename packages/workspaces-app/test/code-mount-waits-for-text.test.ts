import type { FeedbackClient } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { mountCode } from '../src/code/code-app.ts';
import type { MountContext } from '../src/mount-context.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * The diff surface builds its editor once, with the file's text in it. Built
 * before the text arrives, the merge view compares the base with nothing, draws
 * the whole base as one deletion, and compares again: on a large file those
 * passes are most of a file switch.
 */
const built = vi.hoisted(() => [] as string[]);

vi.mock('../src/code/code-editor.ts', () => ({
  createCodeEditor: (opts: { ydoc: Y.Doc }) => {
    built.push(opts.ydoc.getText('codemirror').toString());
    return {
      destroy: () => {},
      setViewMode: () => {},
      getIgnoreWhitespace: () => true,
      getHiddenWhitespaceCount: () => 0,
    };
  },
}));
vi.mock('../src/review-chrome.ts', () => ({
  mountReviewChrome: () => ({ renderDocLabel: () => {}, redrawThreads: () => {} }),
}));

function pageChrome(): void {
  document.body.innerHTML =
    '<div id="editor"></div><button id="comment-pill"></button><div id="view-toggle"></div>';
}

function rig(diff: unknown): { ctx: MountContext; sync(): void; close(): void } {
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json(diff)));
  const ydoc = new Y.Doc();
  let ready: () => void = () => {};
  let status: (s: 'closed') => void = () => {};
  const client = {
    ydoc,
    awareness: { setLocalStateField: () => {} },
    onReady: (cb: () => void) => {
      const prior = ready;
      ready = () => {
        prior();
        cb();
      };
    },
    onStatus: (cb: (s: 'closed') => void) => {
      status = cb;
    },
  } as unknown as FeedbackClient;
  const ctx = {
    docId: 'review-1:src~harborlight.ts',
    docType: 'diff',
    scope: new MountScope(),
    client,
    user: { id: 'u', name: 'Alice', kind: 'known', color: '#000' },
    canWrite: false,
    sourceUrl: '',
    workspaceId: '',
    relPath: 'src/harborlight.ts',
    diffTarget: 'HEAD',
  } as unknown as MountContext;
  return {
    ctx,
    sync() {
      ydoc.getText('codemirror').insert(0, 'const tide = 2;\n');
      ready();
    },
    close: () => status('closed'),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  built.length = 0;
  pageChrome();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the diff surface and its text', () => {
  const diff = { baseText: 'const tide = 1;\n', status: 'modified' };

  it('builds the editor once the text has arrived, with the text in it', async () => {
    const { ctx, sync } = rig(diff);
    const mounted = mountCode(ctx);
    await settle();
    expect(built).toEqual([]);
    sync();
    await mounted;
    expect(built).toEqual(['const tide = 2;\n']);
  });

  it('still mounts when the socket closes first, on what the doc holds', async () => {
    const { ctx, close } = rig(diff);
    const mounted = mountCode(ctx);
    await settle();
    close();
    await mounted;
    expect(built).toEqual(['']);
  });

  it('builds nothing when the reader left before the text arrived', async () => {
    const { ctx, sync } = rig(diff);
    const mounted = mountCode(ctx);
    await settle();
    ctx.scope.dispose();
    sync();
    await mounted;
    expect(built).toEqual([]);
  });

  it('does not wait when there is no base text to compare with', async () => {
    const { ctx } = rig({ baseText: null, error: 'worktree pruned' });
    await mountCode(ctx);
    expect(built).toEqual(['']);
  });
});
