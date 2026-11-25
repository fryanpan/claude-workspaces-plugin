/**
 * The stall scan's cold reads: what it may skip, and what it loads before the
 * synchronous pass rather than inside it.
 *
 * The scan asks every task body and board doc for its threads in one
 * synchronous pass. A doc not in memory used to be loaded inside that pass,
 * so the first pass after a boot, or after an idle sweep released the docs,
 * held the loop for as long as thousands of loads took. Two changes, one
 * `describe` each: a cold doc whose index row says it has nothing to return
 * answers empty without loading, and the timed pass reads the rest first, a
 * slice at a time.
 *
 * "Reads", not "loads", since the scan stopped bringing docs into memory at
 * all (`DocStore.peekThreads`; `stall-pass-no-hydrate.test.ts`): a cold doc's
 * `.ydoc` is decoded into a throwaway copy. That decode is the cost the timed
 * pass still keeps out of the synchronous scan.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import type { TimeSlice } from '../src/event-loop.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SseBus } from '../src/sse.ts';
import { StallNudger } from '../src/stall-nudge.ts';
import { taskBodyDocId } from '../src/task-projection.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

const REVIEWER = {
  id: 'u-harborlight',
  name: 'Harborlight',
  kind: 'known',
  color: '#000',
} as const;

function store(dataDir: string): DocStore {
  return new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
  });
}

/** A slice that yields before every doc and runs `during(n)` inside yield n. */
function scriptedSlice(during: (n: number) => void = () => {}): TimeSlice {
  let count = 0;
  return {
    async yieldIfDue() {
      count++;
      during(count);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    yields: () => count,
  };
}

describe('a cold doc answers a threads read from its index row', () => {
  let dataDir: string;
  let docStore: DocStore;

  /** Four docs written by one store and read by a fresh one, so all are cold:
   *  none has threads, one has an open thread, one only a resolved one. */
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cold-threads-'));
    const writer = store(dataDir);
    for (const id of ['harborlight', 'riverbend', 'saltmarsh']) {
      writer.getOrCreate(id, { type: 'markdown', title: id });
      expect(writer.docEdits.setDocContent(id, `# ${id}\n\nRiverbend notes\n`).ok).toBe(true);
    }
    const open = await writer.createThreadByFind(
      'riverbend',
      { find: 'Riverbend notes' },
      REVIEWER,
      'Still true?',
    );
    expect(open.ok).toBe(true);
    const done = await writer.createThreadByFind(
      'saltmarsh',
      { find: 'Riverbend notes' },
      REVIEWER,
      'Fixed?',
    );
    expect(done.ok).toBe(true);
    if (done.ok)
      expect(writer.docThreads.resolve('saltmarsh', done.thread.id, REVIEWER)).not.toBeNull();
    writer.flush();
    writer.stop();
    docStore = store(dataDir);
  });
  afterEach(() => {
    docStore.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const resident = (docId: string) => docStore.peek(docId) !== undefined;

  it('leaves a doc with no threads unloaded', () => {
    expect(docStore.listThreads('harborlight')).toEqual([]);
    expect(docStore.listThreads('harborlight', { status: 'open' })).toEqual([]);
    expect(resident('harborlight')).toBe(false);
  });

  it('leaves a doc with only resolved threads unloaded when asked for open ones', () => {
    expect(docStore.listThreads('saltmarsh', { status: 'open' })).toEqual([]);
    expect(resident('saltmarsh')).toBe(false);
    // Asked for all of them, it loads and returns the resolved one.
    expect(docStore.listThreads('saltmarsh').map((t) => t.status)).toEqual(['resolved']);
    expect(resident('saltmarsh')).toBe(true);
  });

  it('control: a doc with an open thread loads and returns it', () => {
    expect(docStore.listThreads('riverbend', { status: 'open' })).toHaveLength(1);
    expect(resident('riverbend')).toBe(true);
  });

  it('reads ahead only the docs a read would decode, and loads none of them', async () => {
    docStore.get('harborlight');
    const slice = scriptedSlice();
    const ahead = await docStore.readThreadsAhead(
      new Map<string, 'open' | undefined>([
        ['harborlight', undefined],
        ['riverbend', 'open'],
        ['saltmarsh', 'open'],
      ]),
      slice,
    );

    // Riverbend only: Harborlight is resident, Saltmarsh has no open thread.
    expect(ahead.read).toBe(1);
    expect(slice.yields()).toBe(3);
    expect(resident('riverbend')).toBe(false);
    expect(docStore.peekThreads('riverbend', { status: 'open' })).toHaveLength(1);
    expect(resident('riverbend')).toBe(false);
    ahead.drop();
    // Without the read-ahead the same answer comes off disk, still unloaded.
    expect(docStore.peekThreads('riverbend', { status: 'open' })).toHaveLength(1);
    expect(docStore.peekThreads('saltmarsh').map((t) => t.status)).toEqual(['resolved']);
    expect(resident('riverbend') || resident('saltmarsh')).toBe(false);
  });

  it('two walks that overlap each keep their own read-ahead', async () => {
    // The stall pass and a Home queue read can run at once. When one store
    // held a single read-ahead, the second walk's replaced the first's, and
    // the first walk decoded every doc again inside its synchronous pass.
    const decoded: string[] = [];
    const ds = docStore as unknown as { readColdThreads: (docId: string) => unknown };
    const decode = ds.readColdThreads.bind(ds);
    ds.readColdThreads = (docId) => {
      decoded.push(docId);
      return decode(docId);
    };
    const targets = new Map<string, 'open' | undefined>([['riverbend', 'open']]);
    let inner: number | undefined;
    // The second walk starts, reads, walks and ends while the first is
    // still reading ahead.
    const outer = await docStore.readThreadsAhead(
      targets,
      scriptedSlice(() => {
        if (inner !== undefined) return;
        inner = -1;
        void docStore.readThreadsAhead(targets, scriptedSlice()).then((ahead) => {
          inner = ahead.read;
          expect(docStore.peekThreads('riverbend', { status: 'open' })).toHaveLength(1);
          ahead.drop();
        });
      }),
    );
    expect(inner).toBe(1);
    expect(outer.read).toBe(1);
    decoded.length = 0;

    // The first walk reads what it read ahead, decoding nothing more.
    expect(docStore.peekThreads('riverbend', { status: 'open' })).toHaveLength(1);
    expect(decoded).toEqual([]);
    outer.drop();
    // Control: with no walk holding it, the same read decodes off disk.
    expect(docStore.peekThreads('riverbend', { status: 'open' })).toHaveLength(1);
    expect(decoded).toEqual(['riverbend']);
  });

  it('a doc that leaves memory is struck from a held read-ahead', async () => {
    const ahead = await docStore.readThreadsAhead(
      new Map<string, 'open' | undefined>([['riverbend', 'open']]),
      scriptedSlice(),
    );
    expect(ahead.read).toBe(1);
    // Loaded, its thread resolved, released: the held copy is now stale.
    const [thread] = docStore.listThreads('riverbend', { status: 'open' });
    if (!thread) throw new Error('no open thread');
    expect(docStore.docThreads.resolve('riverbend', thread.id, REVIEWER)).not.toBeNull();
    docStore.flush();
    docStore.evictDoc('riverbend');
    expect(docStore.peek('riverbend')).toBeUndefined();

    expect(docStore.peekThreads('riverbend', { status: 'open' })).toEqual([]);
    ahead.drop();
  });

  it('a read-ahead stops reading once the store stops', async () => {
    const slice = scriptedSlice((n) => {
      if (n === 1) docStore.stop();
    });

    const ahead = await docStore.readThreadsAhead(
      new Map<string, 'open' | undefined>([['riverbend', 'open']]),
      slice,
    );

    expect(ahead.read).toBe(0);
    ahead.drop();
  });
});

describe('the timed stall pass prepares before it ticks', () => {
  function nudger(prepare: () => Promise<unknown>, log: string[]) {
    return new StallNudger({
      prepare,
      snapshot: () => {
        log.push('snapshot');
        return [];
      },
      canReach: () => false,
      send: () => 0,
      report: (message) => log.push(message),
    });
  }

  it('snapshots only after prepare resolves, and skips a pass that would overlap', async () => {
    const log: string[] = [];
    let release = () => {};
    const n = nudger(
      () =>
        new Promise<void>((resolve) => {
          log.push('prepare');
          release = resolve;
        }),
      log,
    );

    const first = n.timedTick();
    const second = n.timedTick();
    await second;
    expect(log).toEqual(['prepare']);

    release();
    await first;
    expect(log).toEqual(['prepare', 'snapshot']);
  });

  it('a pass stopped while preparing does not tick', async () => {
    const log: string[] = [];
    let release = () => {};
    const n = nudger(() => new Promise<void>((resolve) => (release = resolve)), log);

    const pass = n.timedTick();
    n.stop();
    release();
    await pass;

    expect(log).toEqual([]);
  });

  it('a prepare that fails is reported and the pass still ticks', async () => {
    const log: string[] = [];
    const n = nudger(() => Promise.reject(new Error('disk went away')), log);

    await n.timedTick();

    expect(log).toEqual(['[stall-nudge] prepare failed: disk went away', 'snapshot']);
  });
});

describe('the timed stall pass decodes nothing inside the synchronous scan', () => {
  let dataDir: string;
  let handle: ServerHandle | undefined;

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Every doc whose `.ydoc` was decoded for its threads, tagged with
   *  whether a read-ahead was running at the time. */
  function coldDecodes(h: ServerHandle): Array<{ docId: string; ahead: boolean }> {
    const decoded: Array<{ docId: string; ahead: boolean }> = [];
    const ds = h.docStore as unknown as {
      readColdThreads: (docId: string) => unknown;
      readThreadsAhead: (...a: unknown[]) => Promise<unknown>;
    };
    let ahead = false;
    const decode = ds.readColdThreads.bind(ds);
    ds.readColdThreads = (docId) => {
      decoded.push({ docId, ahead });
      return decode(docId);
    };
    const readAhead = ds.readThreadsAhead.bind(ds);
    ds.readThreadsAhead = async (...a) => {
      ahead = true;
      try {
        return await readAhead(...a);
      } finally {
        ahead = false;
      }
    };
    return decoded;
  }

  function evictAll(h: ServerHandle): void {
    for (const meta of h.docStore.list()) h.docStore.evictDoc(meta.docId);
  }

  it('decodes the thread-bearing docs ahead, where the untimed pass decodes them inside', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'stall-cold-'));
    const first = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const ws = first.tasks.createWorkspace('Riverbend board').id;
    const body = 'Agent can rebuild the Saltmarsh index so that search stays fresh.';
    const created = first.tasks.createTask(ws, { title: 'Saltmarsh index', body });
    if (!created.ok) throw new Error('task not created');
    const task = created.task;
    for (const id of ['board-notes', 'board-quiet']) {
      first.docStore.getOrCreate(id, { type: 'markdown', title: id });
      expect(first.docStore.docEdits.setDocContent(id, `# ${id}\n\nHarborlight plan\n`).ok).toBe(
        true,
      );
      first.tasks.attachDoc(ws, id);
    }
    const bodyThread = await first.docStore.createThreadByFind(
      taskBodyDocId(task.id),
      { find: 'Saltmarsh index' },
      REVIEWER,
      'Which index?',
    );
    expect(bodyThread.ok).toBe(true);
    const docThread = await first.docStore.createThreadByFind(
      'board-notes',
      { find: 'Harborlight plan' },
      REVIEWER,
      'Ready?',
    );
    expect(docThread.ok).toBe(true);
    await first.stop();

    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const decoded = coldDecodes(handle);
    const withThreads = [taskBodyDocId(task.id), 'board-notes'];
    const decodedIds = () => decoded.map((d) => d.docId);

    // Control first: the untimed pass, over the same released docs, decodes
    // the thread-bearing ones inside the scan. This is what the spy is for.
    evictAll(handle);
    handle.nudgeStalls();
    expect(withThreads.every((id) => decodedIds().includes(id))).toBe(true);
    expect(decoded.every((d) => !d.ahead)).toBe(true);
    // And the doc with nothing on it is decoded by neither pass.
    expect(decodedIds()).not.toContain('board-quiet');

    evictAll(handle);
    decoded.length = 0;
    await handle.nudgeStallsTimed();
    expect(withThreads.every((id) => decodedIds().includes(id))).toBe(true);
    expect(decoded.filter((d) => !d.ahead)).toEqual([]);
    // Neither pass loaded anything.
    for (const id of [...withThreads, 'board-quiet']) {
      expect(handle.docStore.peek(id)).toBeUndefined();
    }
  });
});
