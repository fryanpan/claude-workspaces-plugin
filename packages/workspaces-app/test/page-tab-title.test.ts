import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A page showing one thing on a board — a doc, a diff file, a folder file, a
 * mock — names the board first and the thing second, and keeps the board's
 * name current without a reload (Bryan, 4 Nov: "every single page has a title
 * that starts with the workspace name").
 */
class FakeSource extends EventTarget {
  static all: FakeSource[] = [];
  readyState = 1;
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeSource.all.push(this);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  fire(type: string, data?: unknown): void {
    this.dispatchEvent(
      new MessageEvent(type, data === undefined ? {} : { data: JSON.stringify(data) }),
    );
  }
}

let names: string[];
let fetched: string[];

async function load() {
  vi.resetModules();
  return import('../src/page-tab-title.ts');
}

beforeEach(() => {
  FakeSource.all = [];
  names = [];
  fetched = [];
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('fetch', (url: string) => {
    fetched.push(url);
    const name = names.shift();
    return Promise.resolve(
      name === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify({ workspace: { name } })),
    );
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a page on a board', () => {
  it('leads with the workspace name, then the page name', async () => {
    const t = await load();
    t.setPageWorkspace({ workspaceId: 'w-1', name: 'Harborlight' });
    t.setPageTitle('tides.md');
    expect(document.title).toBe('Harborlight · tides.md · Workspaces');
  });

  it('follows a rename of its workspace, and ignores another board’s', async () => {
    const t = await load();
    t.setPageWorkspace({ workspaceId: 'w-1', name: 'Harborlight' });
    t.setPageTitle('Riverbend tides');
    const stream = FakeSource.all[0];
    expect(stream?.url).toBe('/workspaces/w-1/events:stream');
    stream?.fire('workspace.renamed', { workspaceId: 'w-2', name: 'Elsewhere' });
    expect(document.title).toBe('Harborlight · Riverbend tides · Workspaces');
    stream?.fire('workspace.renamed', { workspaceId: 'w-1', name: 'Saltmarsh' });
    expect(document.title).toBe('Saltmarsh · Riverbend tides · Workspaces');
  });

  it('reads the name again when a dropped stream comes back', async () => {
    const t = await load();
    t.setPageWorkspace({ workspaceId: 'w-1', name: 'Harborlight' });
    const stream = FakeSource.all[0];
    // The first open is not a reconnect: nothing was missed.
    stream?.fire('open');
    expect(fetched).toEqual([]);
    names.push('Riverbend');
    stream?.fire('error');
    stream?.fire('open');
    await vi.waitFor(() => expect(document.title).toBe('Riverbend · Workspaces'));
    expect(fetched).toEqual(['/workspaces/w-1?format=json']);
  });

  it('moves its stream with the page when the router opens a doc on another board', async () => {
    const t = await load();
    t.setPageWorkspace({ workspaceId: 'w-1', name: 'Harborlight' });
    t.setPageWorkspace({ workspaceId: 'w-1', name: 'Harborlight' });
    expect(FakeSource.all).toHaveLength(1);
    t.setPageWorkspace({ workspaceId: 'w-2', name: 'Riverbend' });
    expect(FakeSource.all[0]?.closed).toBe(true);
    expect(FakeSource.all[1]?.url).toBe('/workspaces/w-2/events:stream');
    t.setPageWorkspace(null);
    expect(FakeSource.all[1]?.closed).toBe(true);
    t.setPageTitle('notes.md');
    expect(document.title).toBe('notes.md · Workspaces');
  });

  it('tells its page when the board’s Library changed', async () => {
    const t = await load();
    const heard = vi.fn();
    t.onPageLibraryChanged(heard);
    t.setPageWorkspace({ workspaceId: 'w-1', name: 'Harborlight' });
    FakeSource.all[0]?.fire('library.changed');
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('a mock’s host page', () => {
  it('names the board, then re-reads the mock’s title when the Library changes', async () => {
    vi.resetModules();
    const { followMockTabTitle } = await import('../src/mock-tab-title.ts');
    const replies: Array<Record<string, unknown>> = [
      { workspace: { name: 'Harborlight' } },
      { meta: { title: 'Riverbend moorings' } },
    ];
    vi.stubGlobal('fetch', (url: string) => {
      fetched.push(url);
      return Promise.resolve(new Response(JSON.stringify(replies.shift() ?? {})));
    });
    await followMockTabTitle({ workspaceId: 'w-1', docId: 'moorings', docTitle: 'Moorings' });
    expect(document.title).toBe('Harborlight · Moorings · Workspaces');
    FakeSource.all[0]?.fire('library.changed');
    await vi.waitFor(() =>
      expect(document.title).toBe('Harborlight · Riverbend moorings · Workspaces'),
    );
    expect(fetched).toEqual([
      '/workspaces/w-1?format=json',
      '/workspaces/w-1/docs/moorings?format=json',
    ]);
  });

  it('leaves the server’s title when the workspace cannot be read', async () => {
    vi.resetModules();
    const { followMockTabTitle } = await import('../src/mock-tab-title.ts');
    document.title = 'Harborlight · Moorings · Workspaces';
    await followMockTabTitle({ workspaceId: 'w-1', docId: 'moorings', docTitle: 'Moorings' });
    expect(document.title).toBe('Harborlight · Moorings · Workspaces');
    expect(FakeSource.all).toHaveLength(0);
  });
});
