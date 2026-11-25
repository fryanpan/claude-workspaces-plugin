/**
 * Our own write-back, still on the pool, is not an outside change.
 *
 * Rapid edits to a bound doc (an agent's find-and-replace run, a burst of
 * accepted suggestions) arm the next write-back while the previous one is
 * still on the thread pool. That write's rename has landed but its callback,
 * which records the new mtime and `lastWritten`, has not run. The next flush's
 * mtime guard used to stat the file at that moment, see a stamp it did not
 * record, and reconcile: disk held our own previous write, the live doc held
 * one edit more, so the conflict arm backed up our own bytes as "external"
 * and logged a disk↔doc conflict.
 *
 * The pool write is held open after its rename by wrapping `boundFiles.write`,
 * the same seam `bound-write-lane.test.ts` uses. Every test restores it.
 *
 * Names and contents are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { type BoundStatResult, boundFiles } from '../src/slow-fs.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { pastWriteBack, waitFor, waitForFile } from './wait-for.ts';

type PoolWrite = (path: string, text: string) => Promise<BoundStatResult>;
const patchable = boundFiles as unknown as { write?: PoolWrite };

const MDX = `# Crossings at Riverbend

The ferry runs hourly from Harborlight.

<PlotChart title="Crossings" series={[{ label: "Saltmarsh route", values: [{ x: 1, y: 800 }, { x: 2, y: 950 }] }]} />

The last boat leaves at dusk.
`;

const MD = `# Crossings at Riverbend

The ferry runs hourly from Harborlight.

The last boat leaves at dusk.
`;

describe('a write-back still on the pool', () => {
  let root: string;
  let dataDir: string;
  let docStore: DocStore;
  const original: PoolWrite = boundFiles.write.bind(boundFiles);

  beforeEach(() => {
    boundFiles.reset();
    root = mkdtempSync(join(tmpdir(), 'cw-inflight-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cw-inflight-data-'));
    docStore = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });
  });

  afterEach(() => {
    patchable.write = original;
    docStore.stop();
    boundFiles.reset();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function bind(name: string, text: string): Promise<string> {
    const path = join(root, name);
    writeFileSync(path, text);
    docStore.getOrCreate(name, { type: 'markdown', sourceUrl: path });
    expect((await docStore.attachFileAsync(name, path)).ok).toBe(true);
    return path;
  }

  function edit(docId: string, find: string, replace: string): void {
    expect(docStore.docEdits.findAndReplace(docId, { find, replace }).ok).toBe(true);
  }

  function backups(): string[] {
    const dir = join(dataDir, 'clobber-backups');
    return existsSync(dir) ? readdirSync(dir) : [];
  }

  for (const [name, text] of [
    ['post.mdx', MDX],
    ['notes.md', MD],
  ] as const) {
    it(`${name}: an edit made while the previous write is landing logs no conflict`, async () => {
      const path = await bind(name, text);
      let writes = 0;
      let open!: () => void;
      const held = new Promise<void>((resolve) => {
        open = resolve;
      });
      // The first write's bytes reach disk; its result does not come back
      // until the test lets it.
      patchable.write = async (p, t) => {
        const res = await original(p, t);
        writes++;
        if (writes === 1) await held;
        return res;
      };
      try {
        edit(name, 'runs hourly', 'runs every half hour');
        await waitFor(() => writes === 1, { describe: 'the first write-back to land on disk' });
        expect(readFileSync(path, 'utf8')).toContain('runs every half hour');
        edit(name, 'at dusk', 'at sunset');
        // timed: one full write-back window, so the second edit's flush fires
        // while the first write is still on the pool — the race under test.
        await Bun.sleep(pastWriteBack());
        open();
        await waitForFile(path, (body) => body.includes('at sunset'), {
          describe: 'the second edit on disk',
        });
        expect(docStore.getDocStatus(name)?.syncError).toBeUndefined();
        expect(backups()).toEqual([]);
        expect(readFileSync(path, 'utf8')).toContain('runs every half hour');
      } finally {
        open();
        patchable.write = original;
      }
    });
  }

  it('a genuine outside write during pending edits is still backed up and reasserted over', async () => {
    const path = await bind('post.mdx', MDX);
    edit('post.mdx', 'runs hourly', 'runs every half hour');
    // Written by another editor before the debounce carries the edit out.
    const outside = MDX.replace('at dusk', 'at midnight');
    writeFileSync(path, outside);
    await waitFor(() => docStore.getDocStatus('post.mdx')?.syncError, {
      describe: 'the conflict to be recorded',
    });
    const saved = backups();
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(dataDir, 'clobber-backups', saved[0] ?? ''), 'utf8')).toBe(outside);
    await waitForFile(path, (body) => body.includes('runs every half hour'), {
      describe: 'the live edits reasserted to disk',
    });
  });

  // The flake PR 1285's CI hit: the flush reconciled the outside write while
  // the poll's read of the same bytes was still on the pool, and when that
  // read came back it reconciled them again — two backups, two conflicts.
  it('an outside write the poll is still reading is backed up once', async () => {
    const path = await bind('post.mdx', MDX);
    let reads = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = boundFiles.read.bind(boundFiles);
    const patchRead = boundFiles as unknown as { read: typeof read };
    patchRead.read = async (p, o) => {
      const res = await read(p, o);
      reads++;
      await held;
      return res;
    };
    try {
      const outside = MDX.replace('at dusk', 'at midnight');
      writeFileSync(path, outside);
      await waitFor(() => reads >= 1, { describe: 'the poll to read the outside write' });
      edit('post.mdx', 'runs hourly', 'runs every half hour');
      await waitFor(() => docStore.getDocStatus('post.mdx')?.syncError, {
        describe: 'the flush to record the conflict',
      });
      release();
      // The reassert is a write-back window after the conflict; every held
      // read's callback has run by the time it lands.
      await waitForFile(path, (body) => body.includes('runs every half hour'), {
        describe: 'the live edits reasserted to disk',
      });
      const saved = backups();
      expect(saved).toHaveLength(1);
      expect(readFileSync(join(dataDir, 'clobber-backups', saved[0] ?? ''), 'utf8')).toBe(outside);
    } finally {
      release();
      patchRead.read = read;
    }
  });
});
