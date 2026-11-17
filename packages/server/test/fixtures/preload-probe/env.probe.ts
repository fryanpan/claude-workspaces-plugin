// Run by `preload-from-any-dir.test.ts` in a child `bun test`. Not named
// `*.test.ts`, so the suite never runs it directly.
import { test } from 'bun:test';

test('reports what the preloads set', () => {
  const e = process.env;
  const line = [e.CW_TEST_SUITE_PRELOADED, e.CW_TEST_BIND_HOST, e.CW_TEST_TIMING_SCALE];
  console.log(`PRELOAD-PROBE ${JSON.stringify(line.map((v) => v ?? null))}`);
});
