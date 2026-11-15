/**
 * The file poll keeps the loop, and the other docs, moving while one bound
 * file's stat has not answered.
 *
 * Prod's `[loop] blocked` lines named `file-poll` on hourly blocks of 1–4.7s
 * with little CPU, at a time of day when the host's disk is slow. The poll's
 * stat has been on the thread pool since PR 682, so these tests pin what that
 * buys rather than rebuild it: while one file's stat is held pending, the
 * sweep keeps running, another doc's external edit still arrives, the loop
 * keeps turning, and the held file is stat'd once rather than once a tick.
 * The edit to the held file arrives as soon as its stat answers.
 *
 * The stat is held through `boundFiles.useStatForTests`, which replaces the
 * one syscall `statMtime` makes. Nothing else about the poll is stubbed.
 *
 * Mutation controls, run by hand: deleting the `statInFlight` guard in
 * `pollBinding` fails the once-only count (the held file reaches 2+ pending
 * stats); making the sweep skip its whole tick while any stat is in flight
 * fails it too, because the held file reaches its deadline before the
 * healthy one is stat'd again.
 *
 * Every fixture is invented.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { BigIntStats } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { SLOW_POLL_STAT_MS } from '../src/file-binding.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

const doc = (line: string) => `# Harborlight notes\n\n${line}\n`;

/**
 * A stat seam that holds every stat of one path until released, and counts
 * how many of them are pending at once. Other paths get the real stat.
 */
function holdStatsOf(held: string) {
  const releases: Array<() => void> = [];
  let calls = 0;
  let pending = 0;
  let maxPending = 0;
  let otherCalls = 0;
  let open = false;
  const real = (path: string) => stat(path, { bigint: true });
  boundFiles.useStatForTests((path): Promise<BigIntStats> => {
    if (path !== held || open) {
      if (path !== held) otherCalls++;
      return real(path);
    }
    calls++;
    pending++;
    maxPending = Math.max(maxPending, pending);
    return new Promise<BigIntStats>((resolve, reject) => {
      releases.push(() => {
        pending--;
        real(path).then(resolve, reject);
      });
    });
  });
  return {
    calls: () => calls,
    pending: () => pending,
    maxPending: () => maxPending,
    otherCalls: () => otherCalls,
    /** Answer every held stat, and let later ones through. */
    release: () => {
      open = true;
      for (const r of releases.splice(0)) r();
    },
  };
}

describe('the file poll while one bound file’s stat is pending', () => {
  let root: string;
  let dataDir: string;
  let harbor: string;
  let river: string;
  let docStore: DocStore;
  let seam: ReturnType<typeof holdStatsOf> | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-poll-pending-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cw-poll-pending-data-'));
    harbor = join(root, 'harborlight.md');
    river = join(root, 'riverbend.md');
    writeFileSync(harbor, doc('Harborlight opening line.'));
    writeFileSync(river, doc('Riverbend opening line.'));
    docStore = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });
    for (const [id, path] of [
      ['d-pharb', harbor],
      ['d-priv', river],
    ] as const) {
      docStore.getOrCreate(id, { type: 'markdown', sourceUrl: path });
      expect(docStore.attachFile(id, path).ok).toBe(true);
    }
  });

  afterEach(() => {
    seam?.release();
    seam = undefined;
    boundFiles.useStatForTests();
    boundFiles.reset();
    docStore.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  const liveText = (id: string) => docStore.getDoc(id)?.plainText ?? '';
  const untilLive = (id: string, needle: string) =>
    waitFor(() => liveText(id).includes(needle), { describe: `${id} to hold "${needle}"` });

  it('positive control: an edit reaches the doc through the poll’s stat', async () => {
    seam = holdStatsOf(harbor);
    seam.release(); // nothing held: every stat answers at once
    writeFileSync(river, doc('Riverbend saved from an editor.'));
    await untilLive('d-priv', 'Riverbend saved from an editor.');
    // The seam saw the poll's stats, so the edit came through the async path.
    expect(seam.otherCalls()).toBeGreaterThan(0);
  });

  it('keeps sweeping the other docs, and stats the held file once, until it answers', async () => {
    seam = holdStatsOf(harbor);
    writeFileSync(harbor, doc('Harborlight edited while its disk was slow.'));
    writeFileSync(river, doc('Riverbend edited meanwhile.'));
    await waitFor(() => seam?.calls() === 1, { describe: 'the poll to stat the held file' });

    let turns = 0;
    let spinning = true;
    const spin = () => {
      turns++;
      if (spinning) setImmediate(spin);
    };
    setImmediate(spin);
    const otherBefore = seam.otherCalls();
    let quarantinedFirst = false;
    try {
      // Two more sweeps over the healthy file BEFORE the held one hits the
      // slow-fs deadline (six poll ticks at any timing scale). A sweep that
      // waited on the held stat would resume only once the deadline freed it,
      // by which time the held path is quarantined.
      await waitFor(
        () => {
          quarantinedFirst = boundFiles.quarantined(harbor);
          return quarantinedFirst || (seam?.otherCalls() ?? 0) >= otherBefore + 2;
        },
        { describe: 'two more sweeps, or the held file’s deadline' },
      );
      await untilLive('d-priv', 'Riverbend edited meanwhile.');
    } finally {
      spinning = false;
    }
    expect(quarantinedFirst).toBe(false);

    // The loop turned freely while the stat was out. A sweep blocked on it
    // would allow none of these.
    expect(turns).toBeGreaterThan(10);
    // One stat outstanding for the held file, however many ticks went by.
    // Past the slow-fs deadline the path is quarantined, so later ticks are
    // refused at the gate and still issue no second stat.
    expect(seam.maxPending()).toBe(1);
    expect(seam.calls()).toBe(1);
    expect(liveText('d-pharb')).not.toContain('edited while its disk was slow');

    seam.release();
    // If the hold outlasted the deadline the path sits in quarantine; lift it
    // so the next tick re-stats rather than waiting out the backoff.
    boundFiles.reset();
    await untilLive('d-pharb', 'Harborlight edited while its disk was slow.');
  });

  it('names the doc, never the path, when a stat is slow', async () => {
    const lines: string[] = [];
    const errors = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      // Only the held file is polled here. The log allows one slow-stat line
      // per window across every doc, and a loaded runner stats a healthy
      // file in more than SLOW_POLL_STAT_MS: Riverbend's line then takes the
      // window and Harborlight's is only counted, so no wait can find it.
      expect(docStore.evictDoc('d-priv')).toBe(true);
      seam = holdStatsOf(harbor);
      writeFileSync(harbor, doc('Harborlight after a slow stat.'));
      await waitFor(() => seam?.calls() === 1, { describe: 'the poll to stat the held file' });
      // timed: holds the stat past the slow-stat threshold it is proving
      await new Promise((r) => setTimeout(r, SLOW_POLL_STAT_MS * 2));
      seam.release();
      const line = await waitFor(
        () => lines.find((l) => l.startsWith('[file-poll] d-pharb: stat took')),
        { describe: 'the slow-stat line' },
      );
      expect(line).not.toContain(root);
      expect(line).not.toContain('harborlight.md');
      // One line per window, though the held file is stat'd again after it.
      // Counted for this doc only: the window is per DocStore, and a store
      // another test file left polling in this process logs its own slow
      // stats into the same console (CI logged `d1` lines here).
      expect(lines.filter((l) => l.startsWith('[file-poll] d-pharb:'))).toHaveLength(1);
      expect(lines.filter((l) => l.includes(root))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});
