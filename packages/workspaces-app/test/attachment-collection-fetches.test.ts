import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDiffNav } from '../src/diff-nav.ts';
import { renderWorkspaceTree } from '../src/workspace-tree.ts';

/**
 * The sidebar asks the server for an ATTACHMENT SET, so it asks under
 * `attachments`.
 *
 * The segment moved from `reviews` on 2026-09-07 and nothing failed when it
 * was moved back: the five client call sites that build these URLs had no
 * test between them, so a typo in any of them would have reached prod as a
 * sidebar that silently renders nothing (both readers here swallow a failed
 * fetch by design, which is what makes the silence total).
 *
 * These two are the call sites reachable from an exported entry point. The
 * other three — the all-files list behind the Changed/All toggle, and the
 * context-file and editable-file writes behind click handlers — are still
 * covered only by the server's own route tests.
 */
function harness(): { urls: string[] } {
  const urls: string[] = [];
  document.body.innerHTML = `
    <div id="set-pane-list"></div>
    <div id="doc-menu"></div>
    <div id="diff-nav"></div>`;
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(new Response('{}', { status: 500 }));
  });
  return { urls };
}

describe('the sidebar fetches an attachment set under `attachments`', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for the set tree at attachments/<setId>/tree', async () => {
    const { urls } = harness();
    await renderWorkspaceTree('d-1', 'set-9');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/attachments/set-9/tree');
    // The control: the retired collection is not what it asked for. A bare
    // `toContain` on the new name would also pass on `/reviews/attachments/`.
    expect(urls[0]).not.toContain('/reviews/');
  });

  it('asks for the grouped model at attachments/<setId>/grouped', async () => {
    const { urls } = harness();
    await renderDiffNav('d-1', 'set-9');
    expect(urls.some((u) => u.includes('/attachments/set-9/grouped'))).toBe(true);
    expect(urls.some((u) => u.includes('/reviews/'))).toBe(false);
  });
});
