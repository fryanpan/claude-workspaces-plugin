/**
 * An open folder review hears a file written straight to disk
 * (`folder-watch.ts`), and the watch lives exactly as long as a page holds
 * the review's stream.
 *
 * The server cases bind a real temp folder, open the stream the page holds,
 * and then write with `writeFileSync` the way an agent's Write or a git
 * checkout would — no re-bind, no refresh call. The unit cases drive the
 * decision with an injected watch so "a save is not news" is asserted
 * without racing a filesystem.
 *
 * All fixtures are invented. Port 0, temp data dirs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOC_STORE_TIMINGS } from '../src/doc-store-timings.ts';
import {
  MAX_WAIT_MS,
  SETTLE_MS,
  type WatchFn,
  createFolderWatches,
  folderListing,
  isWatchedPath,
  timerWatch,
  watchCanWedge,
} from '../src/folder-watch.ts';
import { NUDGE_COALESCE_MS } from '../src/page-nudges.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { framesOf } from './stream-frames.ts';
import { waitFor } from './wait-for.ts';

/** Past one burst's whole journey: settle, the pass, the coalesced frame. */
const PAST_A_BURST = MAX_WAIT_MS + NUDGE_COALESCE_MS * 2 + 300;

describe('folder watch, after a burst', () => {
  // First in the file, so nothing earlier in this process can have wedged
  // the watcher before the burst it is about.
  it('a burst too big for one read leaves the next folder still heard', async () => {
    // Bun 1.3.10's inotify reader never cleared its "more in the buffer"
    // offset (oven-sh/bun#27668). After one read() returned more than 128
    // events, the File Watcher thread replayed that buffer's tail forever
    // and every watch in the process went deaf. A checkout that deletes a
    // directory of a few hundred files is one such read. On that runtime the
    // default watch is a timer (`watchCanWedge`), so this holds there too.
    const big = mkdtempSync(join(tmpdir(), 'folder-watch-burst-'));
    const next = mkdtempSync(join(tmpdir(), 'folder-watch-next-'));
    try {
      mkdirSync(join(big, 'docs'));
      for (let i = 0; i < 600; i++) writeFileSync(join(big, 'docs', `n-${i}.md`), '#\n');
      const refreshed = new Set<string>();
      const watches = createFolderWatches(
        {
          sourceOf: (id) => ({ root: id === 'big' ? big : next }),
          refresh: async (id) => void refreshed.add(id),
        },
        { settleMs: 20, maxWaitMs: 100 },
      );
      watches.sync('big', 1);
      await waitFor(
        () => {
          writeFileSync(join(big, 'first.md'), '# Harborlight\n');
          return refreshed.has('big');
        },
        { describe: 'the burst folder to be heard at all' },
      );
      rmSync(join(big, 'docs'), { recursive: true });
      watches.sync('next', 1);
      await waitFor(
        () => {
          writeFileSync(join(next, 'tides.md'), '# Riverbend\n');
          return refreshed.has('next');
        },
        { describe: 'the folder opened after the burst to be heard' },
      );
      watches.dispose();
    } finally {
      rmSync(big, { recursive: true, force: true });
      rmSync(next, { recursive: true, force: true });
    }
  });
});

describe('folder watch, through the server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;
  let setId = '';
  const host = { host: 'localhost' };
  const open = async (query = '') => {
    const abort = new AbortController();
    const res = await fetch(`${base}/workspaces/${setId}/events:stream${query}`, {
      headers: host,
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    return framesOf(res, abort);
  };
  const changes = (page: { names: () => string[] }) =>
    page.names().filter((n) => n === 'attachments.changed').length;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'folder-watch-data-'));
    folder = mkdtempSync(join(tmpdir(), 'folder-watch-'));
    writeFileSync(join(folder, 'README.md'), '# Harborlight\n');
    writeFileSync(join(folder, 'guide.md'), '# Saltmarsh guide\n');
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const bound = await handle.docStore.bindFolder({ folderPath: folder });
    if (!bound.ok) throw new Error('bind failed');
    setId = bound.setId;
    // timed: past the bind's own persist and coalesced frame, so a frame
    // counted below can only come from the disk.
    await new Promise((r) => setTimeout(r, DOC_STORE_TIMINGS.persistMs + NUDGE_COALESCE_MS * 2));
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('a file written to disk reaches an open page as one frame', async () => {
    const page = await open();
    try {
      await waitFor(() => handle.folderWatches.size() === 1);
      writeFileSync(join(folder, 'tides.md'), '# Riverbend tides\n');
      await waitFor(() => changes(page) >= 1);
      // timed: a whole burst window, to prove the one write sent one frame.
      await new Promise((r) => setTimeout(r, PAST_A_BURST));
      expect(changes(page)).toBe(1);
      // What the page re-reads on that frame (the `/files` route's body).
      const listed = handle.docStore.listRepoFiles(setId).files ?? [];
      expect(listed.map((f) => f.relPath)).toContain('tides.md');
    } finally {
      page.stop();
    }
  });

  it('a burst of 200 writes sends a bounded handful of frames', async () => {
    const page = await open();
    try {
      await waitFor(() => handle.folderWatches.size() === 1);
      for (let i = 0; i < 200; i++) writeFileSync(join(folder, `note-${i}.md`), `# ${i}\n`);
      await waitFor(() => changes(page) >= 1);
      // timed: two burst windows, long enough for any straggler pass.
      await new Promise((r) => setTimeout(r, PAST_A_BURST * 2));
      expect(changes(page)).toBeLessThanOrEqual(3);
    } finally {
      page.stop();
    }
  });

  it('holds one watch per folder and releases it with the last page', async () => {
    const agent = await open('?agentId=riverbend');
    // timed: an agent's stream alone must start nothing.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(handle.folderWatches.size()).toBe(0);
    const first = await open();
    const second = await open();
    await waitFor(() => handle.folderWatches.size() === 1);
    first.stop();
    second.stop();
    await waitFor(() => handle.folderWatches.size() === 0);
    agent.stop();
  });
});

describe('folder watch decisions', () => {
  /** A watch whose events the test fires by hand, over a listing it sets. */
  function harness() {
    let emit: (rel: string | null) => void = () => {};
    let closed = 0;
    const watch: WatchFn = (_root, onEvent) => {
      emit = onEvent;
      return { close: () => void closed++ };
    };
    const listing = new Set(['README.md', 'docs/guide.md']);
    let refreshes = 0;
    let passes = 0;
    const watches = createFolderWatches(
      {
        sourceOf: (id) => (id === 'set-1' ? { root: '/srv/harborlight' } : undefined),
        refresh: async () => void refreshes++,
      },
      {
        watch,
        listPaths: async () => {
          passes++;
          return new Set(listing);
        },
        settleMs: 5,
        maxWaitMs: 20,
      },
    );
    return {
      watches,
      listing,
      passes: () => passes,
      emit: (rel: string | null) => emit(rel),
      refreshes: () => refreshes,
      closed: () => closed,
    };
  }

  it('a save leaves the listing alone and refreshes nothing; an add and a delete do', async () => {
    const h = harness();
    h.watches.sync('set-1', 1);
    // The first burst always refreshes: its listing has no earlier one.
    h.emit('README.md');
    await waitFor(() => h.refreshes() === 1);
    h.emit('README.md.tmp-1');
    h.emit('README.md');
    await waitFor(() => h.passes() === 2);
    // The refresh decision follows the listing on the next turn.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.refreshes()).toBe(1);
    h.listing.add('tides.md');
    h.emit('tides.md');
    await waitFor(() => h.refreshes() === 2);
    h.listing.delete('docs/guide.md');
    h.emit('docs');
    await waitFor(() => h.refreshes() === 3);
    h.watches.dispose();
  });

  it('a burst of events is one pass', async () => {
    const h = harness();
    h.watches.sync('set-1', 1);
    for (let i = 0; i < 200; i++) h.emit(`note-${i}.md`);
    await waitFor(() => h.refreshes() === 1);
    // Two hundred events before the first timer fired: one listing.
    expect(h.passes()).toBe(1);
    h.watches.dispose();
  });

  it('ignores churn under .git and node_modules', () => {
    expect(isWatchedPath('.git/index')).toBe(false);
    expect(isWatchedPath('web/node_modules/a/index.js')).toBe(false);
    expect(isWatchedPath('.claude/rules/a.md')).toBe(true);
    expect(isWatchedPath('notes/tides.md')).toBe(true);
  });

  it('a board channel starts no watch, and release closes the handle', () => {
    const h = harness();
    h.watches.sync('board-1', 1);
    expect(h.watches.size()).toBe(0);
    h.watches.sync('set-1', 2);
    h.watches.sync('set-1', 1);
    expect(h.watches.size()).toBe(1);
    h.watches.sync('set-1', 0);
    expect(h.watches.size()).toBe(0);
    expect(h.closed()).toBe(1);
  });

  /** Drives a real folder through `watch`, or the platform's own watch. */
  async function atomicSave(watch?: WatchFn): Promise<void> {
    const folder = mkdtempSync(join(tmpdir(), 'folder-watch-save-'));
    try {
      writeFileSync(join(folder, 'README.md'), '# Harborlight\n');
      let refreshes = 0;
      let passes = 0;
      const watches = createFolderWatches(
        { sourceOf: () => ({ root: folder }), refresh: async () => void refreshes++ },
        {
          settleMs: 20,
          maxWaitMs: 100,
          ...(watch ? { watch } : {}),
          // Counted once the listing is back: the refresh decision follows
          // it synchronously, so a counted pass has already decided.
          listPaths: async ({ root }) => {
            const listed = await folderListing(root);
            passes++;
            return listed;
          },
        },
      );
      watches.sync('set-1', 1);
      // The first burst is the one that always refreshes. Keep writing the
      // same file until it has; rewrites leave the listing alone.
      await waitFor(() => {
        writeFileSync(join(folder, 'first.md'), '# Saltmarsh\n');
        return refreshes === 1;
      });
      const before = passes;
      writeFileSync(join(folder, 'README.md.tmp'), '# Harborlight, saved\n');
      renameSync(join(folder, 'README.md.tmp'), join(folder, 'README.md'));
      // A pass that saw the save ran, and compared equal.
      await waitFor(() => passes > before);
      expect(refreshes).toBe(1);
      writeFileSync(join(folder, 'tides.md'), '# Riverbend\n');
      await waitFor(() => refreshes === 2);
      watches.dispose();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  it('an atomic save on a real folder refreshes nothing; a new file does', () => atomicSave());

  it('the same holds when the watch is a timer', () => atomicSave(timerWatch(50)));

  it('a timer on a folder that disappears refreshes once, not on every tick', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'folder-watch-gone-'));
    const moved = `${folder}-moved`;
    writeFileSync(join(folder, 'README.md'), '# Harborlight\n');
    let refreshes = 0;
    let passes = 0;
    const watches = createFolderWatches(
      { sourceOf: () => ({ root: folder }), refresh: async () => void refreshes++ },
      {
        watch: timerWatch(20),
        settleMs: 5,
        maxWaitMs: 20,
        listPaths: async ({ root }) => {
          const listed = await folderListing(root);
          passes++;
          return listed;
        },
      },
    );
    try {
      watches.sync('set-1', 1);
      await waitFor(() => refreshes === 1);
      // A rename, so the folder goes in one step. `rmSync` empties it first,
      // and a pass that lists the empty folder has seen a real change of its
      // own, which makes a second refresh correct and this count wrong.
      renameSync(folder, moved);
      // Gone is news once: the refresh is what drops the review's files.
      await waitFor(() => refreshes === 2);
      const after = passes;
      await waitFor(() => passes >= after + 3);
      expect(refreshes).toBe(2);
    } finally {
      watches.dispose();
      rmSync(folder, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
    }
  });

  it('only Linux under Bun before 1.3.11 gets the timer', () => {
    expect(watchCanWedge('linux', '1.3.10')).toBe(true);
    expect(watchCanWedge('linux', '1.3.11')).toBe(false);
    expect(watchCanWedge('linux', '1.4.0')).toBe(false);
    expect(watchCanWedge('linux', '1.2.21')).toBe(true);
    expect(watchCanWedge('darwin', '1.3.10')).toBe(false);
  });
});
