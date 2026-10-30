/**
 * Step 5 of the transcript store's proof (`infra/project-machine/store-time.ts`):
 * the time from an event being written to an analysis on the Mac reading
 * it, on a simulated clock so the test asserts the schedule rather than how
 * fast this machine is, and the zstd ratio of one minute of a file's growth.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type SetupOps,
  setupStoreTest,
  storeTestNames,
} from '../../../infra/project-machine/store-setup.ts';
import { chunkRatio, sampleRatio, timeEvent } from '../../../infra/project-machine/store-time.ts';
import { startFakeTigris } from './fake-tigris.ts';

const tigris = startFakeTigris();
const scratch = mkdtempSync(join(tmpdir(), 'cw-store-time-'));
afterAll(() => {
  tigris.stop();
  rmSync(scratch, { recursive: true, force: true });
});

function memoryOps(): SetupOps {
  const entries = new Map<string, string>();
  return {
    keychainHas: (n) => entries.has(n),
    keychainRead: (n) => entries.get(n) ?? '',
    keychainCreate: (n, v) => void entries.set(n, v),
    createBucket: async (name) => tigris.createBucket(name),
    iamUrl: tigris.iamUrl,
  };
}

/** A clock that moves only when slept on. */
function simulated(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += Math.max(0, ms);
    },
  };
}

describe('event to analysis', () => {
  it('waits for the next upload tick, then the next read sees it', async () => {
    const names = storeTestNames('cw-time-a-test');
    const ops = memoryOps();
    await setupStoreTest(names, ops);
    const lines: string[] = [];
    const r = await timeEvent(
      names,
      ops,
      mkdtempSync(join(scratch, 'a-')),
      { intervalS: 60, pollS: 5, timeoutS: 600, phase: 0.5 },
      (l) => lines.push(l),
      simulated(),
    );
    // Written 30 s into a 60 s tick: it goes up at the tick and is read then.
    expect(r.writeToLandedS).toBe(30);
    expect(r.writeToVisibleS).toBe(30);
    expect(r.reads).toBeGreaterThanOrEqual(2);
    expect(lines.join('\n')).toMatch(/PASS step 5: event to analysis in 30 s/);
  });

  it('fails when the event never becomes readable', async () => {
    const names = storeTestNames('cw-time-b-test');
    const ops = memoryOps();
    await setupStoreTest(names, ops);
    const lines: string[] = [];
    const r = await timeEvent(
      names,
      ops,
      mkdtempSync(join(scratch, 'b-')),
      // The upload tick comes after the deadline.
      { intervalS: 900, pollS: 5, timeoutS: 300, phase: 0.1 },
      (l) => lines.push(l),
      simulated(),
    );
    expect(r.writeToVisibleS).toBeNull();
    expect(lines.join('\n')).toMatch(/FAIL step 5/);
  });
});

describe('the zstd ratio of one minute', () => {
  it('compresses only the whole lines the file gained while it watched', async () => {
    const path = join(scratch, 'grow.jsonl');
    const row = (i: number) =>
      `${JSON.stringify({ type: 'assistant', n: i, message: { content: 'Riverbend survey notes '.repeat(8) } })}\n`;
    writeFileSync(path, row(0));
    const r = await sampleRatio(path, 60, async (ms) => {
      expect(ms).toBe(60_000);
      for (let i = 1; i <= 50; i++) appendFileSync(path, row(i));
      appendFileSync(path, '{"half":');
    });
    let grown = '';
    for (let i = 1; i <= 50; i++) grown += row(i);
    expect(r.raw).toBe(Buffer.byteLength(grown));
    expect(r).toEqual(chunkRatio(Buffer.from(grown)));
    expect(r.ratio).toBeGreaterThan(3);
  });

  it('says so when nothing was written', async () => {
    const path = join(scratch, 'still.jsonl');
    writeFileSync(path, '{}\n');
    await expect(sampleRatio(path, 60, async () => {})).rejects.toThrow(/no whole line/);
  });
});
