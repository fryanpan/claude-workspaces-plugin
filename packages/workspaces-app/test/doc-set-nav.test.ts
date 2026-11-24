import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { openBoardStream } from '../src/board-stream.ts';
import { wireDiffNavRefresh } from '../src/diff-nav.ts';
import { mountDocSetNav } from '../src/doc/doc-set-nav.ts';
import { MountScope } from '../src/mount-scope.ts';
import { watchSetChanges } from '../src/set-live.ts';
import { resetSidebarSignature } from '../src/sidebar-nav-key.ts';
import { wireWorkspaceTreeRefresh } from '../src/workspace-tree.ts';

/**
 * The set navigation a document carries (doc/doc-set-nav.ts): the sidebar
 * list and the topbar dropdown for its siblings.
 *
 * The column is committed from the LIST, never from the metadata — a doc that
 * names a set is not a doc whose set has anything in it, and a labelled empty
 * panel is width taken from the prose for nothing. Both halves are driven
 * here, plus the review's own push that keeps the list current, and its
 * teardown.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.body.className = '';
  resetSidebarSignature();
});

/** The board the page is standing on — every resource route is under it. */
const WS = 'w-1';

beforeEach(() => {
  history.replaceState(null, '', `/workspaces/${WS}/docs/d1`);
  document.body.innerHTML = `
    <aside id="set-pane"><ol id="set-pane-list"></ol></aside>
    <button id="doc-switcher"></button>
    <div id="doc-menu" class="hidden"></div>`;
});

const list = () => document.getElementById('set-pane-list') as HTMLElement;
const menu = () => document.getElementById('doc-menu') as HTMLElement;

function mount(meta: Record<string, string> = {}, docId = 'd1') {
  const ydoc = new Y.Doc();
  for (const [k, v] of Object.entries(meta)) ydoc.getMap('meta').set(k, v);
  const scope = new MountScope();
  const nav = mountDocSetNav({ docId, navDocId: docId, ydoc, scope });
  open.push(() => {
    scope.dispose();
    ydoc.destroy();
  });
  return { ydoc, scope, nav };
}

/** A stub docs-listing answer, and the URLs it was asked for. */
function stubDocs(docs: unknown[]) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      // The workspace renderers ask for the review's grouped model and its
      // file list; empty ones are enough to make them draw nothing and return.
      const u = String(url);
      const body = u.includes('/grouped')
        ? { groups: [] }
        : u.includes('/files')
          ? { files: [] }
          : { docs };
      return { ok: true, json: async () => body } as Response;
    }),
  );
  return calls;
}

describe('a document that belongs to no set', () => {
  it('gives the column back instead of showing an empty panel', async () => {
    document.body.classList.add('has-set');
    list().innerHTML = '<li>left over from the last document</li>';
    const { nav } = mount();
    await nav.render();
    expect(document.body.classList.contains('has-set')).toBe(false);
    expect(list().innerHTML).toBe('');
    expect(menu().innerHTML).toBe('');
  });
});

describe('a legacy hand-grouped set', () => {
  it('lists the markdown siblings in both the sidebar and the dropdown', async () => {
    const calls = stubDocs([
      { docId: 'd1', setId: 's1', type: 'markdown', title: 'Alpha' },
      { docId: 'd2', setId: 's1', type: 'markdown', title: 'Beta' },
      // Not markdown, and not this set: neither belongs in the list.
      { docId: 'd3', setId: 's1', type: 'code', title: 'Gamma' },
      { docId: 'd4', setId: 's2', type: 'markdown', title: 'Delta' },
    ]);
    const { nav } = mount({ setId: 's1' });
    await nav.render();

    expect(calls).toEqual([`/workspaces/${WS}/docs?setId=s1`]);
    const labels = [...list().querySelectorAll('a')].map((a) => a.textContent);
    expect(labels).toEqual(['Alpha', 'Beta']);
    expect(menu().querySelectorAll('a')).toHaveLength(2);
    expect(document.body.classList.contains('has-set')).toBe(true);
    // The doc being read is marked as the current page, for a screen reader
    // as much as for the eye.
    const active = list().querySelector('a.active') as HTMLAnchorElement;
    expect(active.textContent).toBe('Alpha');
    expect(active.getAttribute('aria-current')).toBe('page');
  });

  it('takes the column back when the set turns out to hold nothing listable', async () => {
    document.body.classList.add('has-set');
    stubDocs([{ docId: 'd9', setId: 's1', type: 'code', title: 'Only code' }]);
    const { nav } = mount({ setId: 's1' });
    await nav.render();
    expect(document.body.classList.contains('has-set')).toBe(false);
    expect(list().innerHTML).toBe('');
  });

  it('escapes a title rather than letting it write markup into the sidebar', async () => {
    stubDocs([{ docId: 'd1', setId: 's1', type: 'markdown', title: '<img src=x>Alpha' }]);
    const { nav } = mount({ setId: 's1' });
    await nav.render();
    expect(list().querySelectorAll('img')).toHaveLength(0);
    expect(list().querySelector('a')?.textContent).toBe('<img src=x>Alpha');
  });

  it('leaves the sidebar alone when the mount was torn down mid-fetch', async () => {
    stubDocs([{ docId: 'd1', setId: 's1', type: 'markdown', title: 'Alpha' }]);
    const { nav, scope } = mount({ setId: 's1' });
    const pending = nav.render();
    scope.dispose();
    await pending;
    expect(list().innerHTML).toBe('');
  });
});

/** The streams the page opened, in order. */
class FakeStream extends EventTarget {
  static opened: FakeStream[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeStream.opened.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

describe("the review's own push", () => {
  beforeEach(() => {
    FakeStream.opened = [];
    vi.stubGlobal('EventSource', FakeStream);
  });

  const frame = async (name: string) => {
    FakeStream.opened.at(-1)?.dispatchEvent(new Event(name));
    await vi.advanceTimersByTimeAsync(0);
  };

  it('a file joining the set redraws the open sidebar, with no timer asking', async () => {
    vi.useFakeTimers();
    const calls = stubDocs([]);
    const { scope } = mount({ workspaceId: 's-harborlight' });
    // Mounting alone asks for nothing: the first paint is the navigation's.
    expect(calls).toHaveLength(0);
    expect(FakeStream.opened.map((s) => s.url)).toEqual([
      '/workspaces/s-harborlight/events:stream',
    ]);

    // No poll: a minute of nothing reads nothing.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(0);

    await frame('attachments.changed');
    const afterFrame = calls.length;
    expect(afterFrame).toBeGreaterThan(0);

    // Focus still re-reads, and so does the stream coming back after a drop.
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBeGreaterThan(afterFrame);
    await frame('error');
    const beforeReopen = calls.length;
    await frame('open');
    expect(calls.length).toBeGreaterThan(beforeReopen);

    const beforeDispose = calls.length;
    scope.dispose();
    expect(FakeStream.opened.at(-1)?.closed).toBe(true);
    window.dispatchEvent(new Event('focus'));
    await frame('attachments.changed');
    expect(calls.length).toBe(beforeDispose);
  });

  it('listens once the synced meta names the set, as a real page boots', async () => {
    vi.useFakeTimers();
    const calls = stubDocs([]);
    // The page mounts before its doc has synced, so the meta is empty here.
    const { ydoc, nav } = mount();
    expect(FakeStream.opened).toHaveLength(0);
    ydoc.getMap('meta').set('workspaceId', 's-harborlight');
    await nav.render();
    await nav.render();
    expect(FakeStream.opened.map((s) => s.url)).toEqual([
      '/workspaces/s-harborlight/events:stream',
    ]);
    const before = calls.length;
    await frame('attachments.changed');
    expect(calls.length).toBeGreaterThan(before);
  });

  it('the diff list and the folder tree a code page wires redraw on the same frame', async () => {
    vi.useFakeTimers();
    const calls = stubDocs([]);
    const stops = [
      wireDiffNavRefresh('d1', 's-riverbend'),
      wireWorkspaceTreeRefresh('d1', 's-saltmarsh'),
    ];
    open.push(() => {
      for (const stop of stops) stop();
    });
    expect(FakeStream.opened.map((s) => s.url)).toEqual([
      '/workspaces/s-riverbend/events:stream',
      '/workspaces/s-saltmarsh/events:stream',
    ]);
    for (const [n, stream] of FakeStream.opened.entries()) {
      const before = calls.length;
      stream.dispatchEvent(new Event('attachments.changed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.length, `stream ${n}`).toBeGreaterThan(before);
    }
  });

  it("joins the page's stream for the set instead of opening a second one", async () => {
    vi.useFakeTimers();
    const calls = stubDocs([]);
    // Another reader of the same channel on the page, opened first.
    const other = openBoardStream('s-harborlight');
    const otherHeard: string[] = [];
    other.addEventListener('attachments.changed', () => otherHeard.push('frame'));
    let refreshed = 0;
    const stop = watchSetChanges('s-harborlight', () => {
      refreshed++;
      void fetch('/refresh');
    });
    expect(FakeStream.opened.map((s) => s.url)).toEqual([
      '/workspaces/s-harborlight/events:stream',
    ]);
    await frame('attachments.changed');
    expect(refreshed).toBe(1);
    expect(otherHeard).toEqual(['frame']);
    expect(calls.length).toBe(1);
    // The sidebar going away leaves the other reader's stream open.
    stop();
    expect(FakeStream.opened[0]?.closed).toBe(false);
    await frame('attachments.changed');
    expect(refreshed).toBe(1);
    expect(otherHeard).toEqual(['frame', 'frame']);
    other.close();
    expect(FakeStream.opened[0]?.closed).toBe(true);
  });
});
