/**
 * The server suite's shard split, and the per-file times it is balanced on.
 *
 * What would go wrong silently is a split that drops or doubles a file, so
 * that is tested first; then that the split is balanced on weight rather
 * than count, and that a CI log reads into the right numbers.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ServerDurations,
  buildServerTable,
  loadServerDurations,
  parseServerDurations,
  serverShard,
} from './server-durations.ts';

const files = Array.from({ length: 17 }, (_, i) => `packages/server/test/f${i}.test.ts`);
const flat: ServerDurations = { unmeasured: 1, seconds: {} };

describe('serverShard', () => {
  it('puts every file in exactly one shard', () => {
    for (const count of [1, 2, 3]) {
      const seen = Array.from({ length: count }, (_, i) =>
        serverShard(files, i + 1, count, flat),
      ).flat();
      expect(seen.slice().sort()).toEqual(files.slice().sort());
    }
  });

  it('puts a file the table has never seen in exactly one shard too', () => {
    const table: ServerDurations = { unmeasured: 0.1, seconds: { [files[0] ?? '']: 30 } };
    const seen = [1, 2].flatMap((i) => serverShard(files, i, 2, table));
    expect(seen.slice().sort()).toEqual(files.slice().sort());
  });

  it('splits on measured time, not on count', () => {
    const [heavy, ...light] = files;
    const seconds: Record<string, number> = { [heavy ?? '']: 40 };
    for (const f of light) seconds[f] = 1;
    const table: ServerDurations = { unmeasured: 1, seconds };
    const [a, b] = [1, 2].map((i) => serverShard(files, i, 2, table));
    // The 40s file shares its shard with nothing; the sixteen 1s files go together.
    expect(a).toEqual([heavy]);
    expect(b).toHaveLength(16);
  });

  it('keeps the order the files came in, so chunks keep their hashed company', () => {
    const shuffled = [...files].reverse();
    const mine = serverShard(shuffled, 1, 2, flat);
    expect(mine).toEqual(shuffled.filter((f) => mine.includes(f)));
  });

  it('answers the same split whatever order the files arrive in', () => {
    const a = serverShard(files, 1, 2, flat).slice().sort();
    const b = serverShard([...files].reverse(), 1, 2, flat)
      .slice()
      .sort();
    expect(a).toEqual(b);
  });

  it('is empty, not wrong, when there are fewer files than shards', () => {
    expect(serverShard(['only.test.ts'], 2, 3, flat)).toEqual([]);
  });
});

const PREFIX = 'server (1)\tUNKNOWN STEP\t2026-11-18T22:16:31.0519818Z ';

describe('parseServerDurations', () => {
  it("sums each file's case times, in ms or s, with or without colour", () => {
    const log = [
      `${PREFIX}##[group]packages/server/test/a.test.ts:`,
      `${PREFIX}^[[32m(pass)^[[0m a > opens [97.00ms]`,
      `${PREFIX}(pass) a > is fast enough to print no time`,
      `${PREFIX}(pass) a > is slow [1.50s]`,
      `${PREFIX}(skip) a > does not run [5000.00ms]`,
      `${PREFIX}##[group]packages/server/test/b.test.ts:`,
      `${PREFIX}(pass) b > waits [400.00ms]`,
      `${PREFIX} 3 pass`,
      `${PREFIX}Ran 4 tests across 2 files. [2.34s]`,
      `${PREFIX}(pass) printed after the footer, so nobody's [9000.00ms]`,
    ].join('\n');
    expect(parseServerDurations(log)).toEqual({
      'packages/server/test/a.test.ts': 1.6,
      'packages/server/test/b.test.ts': 0.4,
    });
  });

  it('reads nothing from a log with no file headers — the control', () => {
    expect(parseServerDurations(`${PREFIX}(pass) orphan [97.00ms]\n${PREFIX}Ran 1 test`)).toEqual(
      {},
    );
  });
});

describe('the table', () => {
  it('sorts its rows and takes the unmeasured weight from the median', () => {
    expect(buildServerTable({ 'b.test.ts': 3, 'a.test.ts': 1, 'c.test.ts': 9 })).toEqual({
      unmeasured: 3,
      seconds: { 'a.test.ts': 1, 'b.test.ts': 3, 'c.test.ts': 9 },
    });
  });

  it('loads as an empty table, not a crash, when the file is unusable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'server-durations-'));
    try {
      const path = join(dir, 'table.json');
      writeFileSync(path, '{"seconds": {}}');
      expect(loadServerDurations(path)).toEqual({ unmeasured: 0, seconds: {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the committed table loads with its rows', () => {
    const table = loadServerDurations();
    expect(Object.keys(table.seconds).length).toBeGreaterThan(1000);
  });
});
