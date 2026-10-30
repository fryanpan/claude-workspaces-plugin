/**
 * Step 5 of the transcript store's test-bucket proof, measured.
 *
 * `timeEvent` runs both sides of the path an analysis depends on. The host
 * side is the uploader with the Fly-style credential, a pass every
 * `intervalS` seconds; the event is written `phase` of the way into a tick,
 * as a real one lands at any moment. The Mac side, with the reading
 * credential and the review key, lists the event file's chunks every `pollS`
 * seconds and opens any it has not seen, the way an on-demand analysis
 * reads the newest data. It reports write to upload, write to readable, and
 * how long one read took. The bar is 5 minutes (Bryan, 28 Oct).
 *
 * `sampleRatio` watches a file for a minute and compresses only the whole
 * lines it gained, at zstd level 3, which is one real chunk's ratio. It
 * prints sizes only.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { recipientOf } from './seal.ts';
import { syntheticFiles } from './store-prove.ts';
import { s3Bucket } from './store-s3.ts';
import {
  FLY_HOST,
  type SetupOps,
  type StoreTestNames,
  TEST_BOARD,
  readCredential,
} from './store-setup.ts';
import { type UploadSource, openChunk, runOnce } from './store-upload.ts';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

export interface TimeOptions {
  intervalS: number;
  pollS: number;
  timeoutS: number;
  /** How far into an upload tick the event is written, 0 to 1. */
  phase: number;
}

export interface TimeResult {
  writeToLandedS: number | null;
  writeToVisibleS: number | null;
  reads: number;
  /** The slowest single read, on the real clock. */
  slowestReadMs: number;
}

const BAR_S = 300;

export async function timeEvent(
  names: StoreTestNames,
  ops: Pick<SetupOps, 'keychainRead'>,
  scratch: string,
  opts: TimeOptions,
  log: (line: string) => void,
  clock: Clock = realClock,
): Promise<TimeResult> {
  const review = ops.keychainRead(names.identities.review).trim();
  const keys = {
    review: recipientOf(review),
    owner: recipientOf(ops.keychainRead(names.identities.owner).trim()),
    boards: { [TEST_BOARD]: recipientOf(ops.keychainRead(names.identities.board).trim()) },
  };
  const writer = s3Bucket(readCredential(ops, names.writer), names.bucket);
  const reader = s3Bucket(readCredential(ops, names.reader), names.bucket);
  const run = `timing-${randomBytes(4).toString('hex')}`;
  const { events } = syntheticFiles(scratch, run);
  const source: UploadSource = {
    path: events,
    kind: 'event',
    name: `${run}.events`,
    board: TEST_BOARD,
  };
  const prefix = `${FLY_HOST}/events/${TEST_BOARD}/${run}.events/`;
  const marker = `marker-${randomBytes(8).toString('hex')}`;
  const statePath = join(scratch, `${run}.state.json`);

  const start = clock.now();
  const writeAt = start + opts.phase * opts.intervalS * 1000;
  const deadline = writeAt + opts.timeoutS * 1000;
  let nextUpload = start;
  let nextPoll = writeAt;
  let written: number | null = null;
  let landed: number | null = null;
  let visible: number | null = null;
  let reads = 0;
  let slowestReadMs = 0;
  const seen = new Set<string>();

  while (visible === null) {
    const due = Math.min(nextUpload, written === null ? writeAt : nextPoll);
    if (due > deadline) break;
    await clock.sleep(due - clock.now());
    if (written === null && due === writeAt && due < nextUpload) {
      appendFileSync(events, `${JSON.stringify({ type: 'timing.probe', marker })}\n`);
      written = clock.now();
      continue;
    }
    if (due === nextUpload) {
      const report = await runOnce({
        sources: [source],
        store: writer,
        statePath,
        host: FLY_HOST,
        keys,
        classOf: () => 'private',
      });
      if (
        written !== null &&
        landed === null &&
        report.uploaded.some((u) => u.key.startsWith(prefix))
      ) {
        landed = clock.now();
      }
      nextUpload += opts.intervalS * 1000;
      if (written === null || due !== nextPoll) continue;
    }
    const t0 = performance.now();
    for (const o of await reader.list(prefix)) {
      if (seen.has(o.key)) continue;
      seen.add(o.key);
      if (
        openChunk(await reader.get(o.key), review)
          .toString('utf8')
          .includes(marker)
      ) {
        visible = clock.now();
      }
    }
    reads++;
    slowestReadMs = Math.max(slowestReadMs, Math.round(performance.now() - t0));
    nextPoll += opts.pollS * 1000;
  }
  const s = (t: number | null) =>
    t === null || written === null ? null : Math.round((t - written) / 1000);
  const result = { writeToLandedS: s(landed), writeToVisibleS: s(visible), reads, slowestReadMs };
  const cadence = `uploads every ${opts.intervalS} s, reads every ${opts.pollS} s`;
  if (result.writeToVisibleS !== null && result.writeToVisibleS <= BAR_S) {
    log(
      `PASS step 5: event to analysis in ${result.writeToVisibleS} s (write to upload ${result.writeToLandedS} s; slowest of ${reads} reads ${slowestReadMs} ms; ${cadence})`,
    );
  } else {
    log(
      `FAIL step 5: event to analysis ${result.writeToVisibleS === null ? `not readable within ${opts.timeoutS} s` : `in ${result.writeToVisibleS} s`}, over the ${BAR_S} s bar (${cadence})`,
    );
  }
  return result;
}

export function chunkRatio(plain: Buffer): { raw: number; compressed: number; ratio: number } {
  const compressed = Bun.zstdCompressSync(plain, { level: 3 }).length;
  return {
    raw: plain.length,
    compressed,
    ratio: Math.round((plain.length / compressed) * 100) / 100,
  };
}

/** The ratio of what `path` gains in whole lines while `wait` runs. */
export async function sampleRatio(
  path: string,
  seconds: number,
  wait: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<{ raw: number; compressed: number; ratio: number }> {
  const from = statSync(path).size;
  await wait(seconds * 1000);
  const to = statSync(path).size;
  const buf = Buffer.alloc(Math.max(0, to - from));
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, buf.length, from);
  } finally {
    closeSync(fd);
  }
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) throw new Error(`no whole line was written to the file in ${seconds} s`);
  return chunkRatio(buf.subarray(0, end + 1));
}
