/**
 * A bound file the attach cannot read is "unavailable", not a crash report.
 *
 * A cloud-sync provider can leave a file online-only — "dataless" — and with
 * materialization off, `open` on it fails at once with EDEADLK (see
 * `dataless-policy.ts`). Production logged a full stack trace for every such
 * doc on every boot, from the attach-time reconcile, and then never read the
 * file again: downloading a file changes neither its mtime nor its size, so
 * the mtime poll had nothing to notice, and whatever the file held — an edit
 * made on another machine, or the write the server itself still owed it —
 * never met the doc.
 *
 * No real dataless file can be made here, so the failure is injected at the
 * read seam: both reads a bound file goes through — `readFileSync` for the
 * attach, `fs/promises.readFile` for the poll — throw EDEADLK for this one
 * path while `dataless` is true. Every other read reaches the disk, and so
 * does `stat`, which answers for a dataless file exactly as it does here.
 * "Downloading" is flipping the flag: the bytes and the mtime do not move.
 *
 * The doc, the paths and the content here are invented.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocIndex, writeDocIndex } from '../src/doc-index.ts';
import { DocStore } from '../src/doc-store.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { pastWriteBack, waitFor, waitForFile } from './wait-for.ts';

const DOC_ID = 'riverbend-notes';
/** What the file on disk holds when the second server boots. */
const ON_DISK = '# Riverbend\n\nThe version sitting in the cloud.\n';
/** What the `.ydoc` holds: an edit whose write-back never reached the file. */
const OWED = '# Riverbend\n\nThe edit the server still owed the file.\n';

const realReadFileSync = fs.readFileSync;
const realReadFile = fsp.readFile;

function newStore(dataDir: string): DocStore {
  return new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

function deadlock(): NodeJS.ErrnoException {
  return Object.assign(new Error('EDEADLK: resource deadlock would occur, open'), {
    code: 'EDEADLK',
    errno: -11,
    syscall: 'open',
  });
}

describe('a bound file that is not downloaded', () => {
  let dataDir: string;
  let scratch: string;
  let boundPath: string;
  let store: DocStore | undefined;
  let dataless: boolean;
  /** Pool reads of the bound file, refused or not — the poll's retries. */
  let poolReads: number;
  /** Every console line, rendered, and how many of ours carried an Error. */
  let lines: string[];
  let stackTraces: number;
  let restores: Array<() => void>;

  beforeEach(() => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'dataless-data-'));
    scratch = mkdtempSync(join(tmpdir(), 'dataless-files-'));
    boundPath = join(scratch, 'riverbend.md');
    dataless = false;
    poolReads = 0;
    lines = [];
    stackTraces = 0;

    // Round one: bound while the file is on disk, then persisted.
    writeFileSync(boundPath, OWED);
    const first = newStore(dataDir);
    first.getOrCreate(DOC_ID, { type: 'markdown', sourceUrl: boundPath });
    expect(first.attachFile(DOC_ID, boundPath).ok).toBe(true);
    first.flush();
    first.stop();

    const isBound = (path: unknown) => path === boundPath;
    const sync = spyOn(fs, 'readFileSync').mockImplementation(((
      path: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (dataless && isBound(path)) throw deadlock();
      return (realReadFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync);
    const pool = spyOn(fsp, 'readFile').mockImplementation(((path: unknown, ...rest: unknown[]) => {
      if (isBound(path)) {
        poolReads++;
        if (dataless) return Promise.reject(deadlock());
      }
      return (realReadFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof fsp.readFile);
    // Only lines about this file count as stack traces: the server suite
    // shares a process, and another file's leftover timers log their own.
    const ours = (line: string) =>
      line.includes('EDEADLK') || line.includes(DOC_ID) || line.includes(scratch);
    const capture = (...args: unknown[]) => {
      const line = args
        .map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
        .join(' ');
      if (args.some((a) => a instanceof Error) && ours(line)) stackTraces++;
      lines.push(line);
    };
    const consoles = (['error', 'warn', 'log'] as const).map((level) =>
      spyOn(console, level).mockImplementation(capture),
    );
    restores = [sync, pool, ...consoles].map((spy) => () => spy.mockRestore());
  });

  afterEach(() => {
    store?.stop();
    store = undefined;
    for (const restore of restores) restore();
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  /**
   * The shape that recurred on every production boot: the server went down
   * owing the file a write, so the next boot hydrates the doc at once to
   * reassert it — and that is the attach whose read fails.
   */
  function owedWriteAtShutdown(): void {
    writeFileSync(boundPath, ON_DISK);
    const row = readDocIndex(dataDir, DOC_ID);
    if (!row) throw new Error('round one wrote no index row');
    writeDocIndex(dataDir, DOC_ID, { ...row, pendingFileWrite: true });
  }

  const liveText = () => store?.getDoc(DOC_ID)?.plainText ?? '';

  it('comes up on its .ydoc with one log line, and settles with the file once it downloads', async () => {
    owedWriteAtShutdown();
    dataless = true;
    store = newStore(dataDir);

    // Served from the `.ydoc`, and bound: the binding is what the poll that
    // retries the read hangs off.
    expect(liveText()).toContain('The edit the server still owed the file.');
    expect(store.boundPathOf(DOC_ID)).toBe(boundPath);

    // One line, naming the doc and the errno. No stack trace, and not the
    // path: a path under a cloud folder can name a private project.
    const deadlocks = lines.filter((line) => line.includes('EDEADLK'));
    expect(deadlocks).toHaveLength(1);
    expect(deadlocks[0]).toContain(DOC_ID);
    expect(stackTraces).toBe(0);
    expect(lines.filter((line) => line.includes(scratch))).toEqual([]);
    // And the owner can see why the file is not being written.
    expect(store.getDoc(DOC_ID)?.syncError?.message).toContain('EDEADLK');

    // The poll keeps asking, whatever the stat says.
    await waitFor(() => poolReads >= 2, { describe: 'the poll to retry the read twice' });
    // The real read, past the double: this assertion is about the bytes.
    expect(realReadFileSync(boundPath, 'utf8')).toBe(ON_DISK);
    // Still one line: a retry on every visit must not log on every visit.
    expect(lines.filter((line) => line.includes('EDEADLK'))).toHaveLength(1);
    expect(stackTraces).toBe(0);

    // The file downloads. Nothing about its stat changes.
    dataless = false;
    // The attach's arbitration runs now, with the bytes in hand: the owed
    // write wins, as it would have at boot, and reaches the file.
    await waitForFile(boundPath, (text) => text.includes('The edit the server still owed'), {
      describe: 'the owed write to land once the file is readable',
    });
    expect(store.getDoc(DOC_ID)?.syncError).toBeUndefined();
  });

  it('positive control: the same boot on a readable file binds and writes at once', async () => {
    owedWriteAtShutdown();
    store = newStore(dataDir);

    expect(store.boundPathOf(DOC_ID)).toBe(boundPath);
    await waitForFile(boundPath, (text) => text.includes('The edit the server still owed'), {
      describe: 'the owed write to land at boot',
    });
    expect(lines.filter((line) => line.includes('EDEADLK'))).toEqual([]);
    expect(store.getDoc(DOC_ID)?.syncError).toBeUndefined();
  });

  it('takes an edit made elsewhere once the file downloads, with no mtime change to notice', async () => {
    // Edited on another machine while this server was down, then evicted to
    // the cloud. The mtime is pushed past the `.ydoc`'s so the attach's
    // arbitration calls disk the newer side, which is what an edit made
    // after the last save is.
    writeFileSync(boundPath, '# Riverbend\n\nEdited on another machine.\n');
    const later = new Date(Date.now() + 60_000);
    utimesSync(boundPath, later, later);
    dataless = true;
    store = newStore(dataDir);
    expect(store.attachFile(DOC_ID, boundPath).ok).toBe(true);
    expect(liveText()).toContain('The edit the server still owed the file.');
    // Something saves the `.ydoc` while the file is away — a comment is
    // enough — and its stamp passes the file's. The verdict was the file's at
    // boot, and a comparison made now would hand it to the doc instead.
    const muchLater = new Date(Date.now() + 120_000);
    utimesSync(join(dataDir, `${DOC_ID}.ydoc`), muchLater, muchLater);

    dataless = false;
    await waitFor(() => liveText().includes('Edited on another machine.'), {
      describe: 'the downloaded edit to reach the doc',
    });
  });

  it('holds an edit made while the file is unreadable, then writes it with the cloud copy kept', async () => {
    writeFileSync(boundPath, ON_DISK);
    dataless = true;
    store = newStore(dataDir);
    expect(store.attachFile(DOC_ID, boundPath).ok).toBe(true);
    store.findAndReplace(DOC_ID, {
      find: 'still owed the file',
      replace: 'typed while it was away',
    });
    expect(liveText()).toContain('typed while it was away');

    // The claim is that nothing happens inside the write-back window, so the
    // wait is the assertion. Before the hold, the write-back landed here and
    // put the `.ydoc` over bytes this server had never read.
    await new Promise((r) => setTimeout(r, pastWriteBack())); // timed: past the write-back debounce
    expect(realReadFileSync(boundPath, 'utf8')).toBe(ON_DISK);

    dataless = false;
    await waitForFile(boundPath, (text) => text.includes('typed while it was away'), {
      describe: 'the held edit to reach the file once it is readable',
    });
    // And the copy it replaced was kept, as every reassert keeps it.
    const backups = join(dataDir, 'clobber-backups');
    const kept = fs
      .readdirSync(backups)
      .map((name) => realReadFileSync(join(backups, name), 'utf8'));
    expect(kept).toContain(ON_DISK);
  });
});
