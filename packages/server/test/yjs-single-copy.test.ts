/**
 * The server loads one copy of Yjs.
 *
 * Two copies are two sets of classes, and Yjs tells its structs apart with
 * `instanceof` — so a Y object made by one copy and handed to the other is
 * misread, silently. One copy is installed today (bun's isolated linker links
 * every `yjs` dependency to the same directory), which is exactly why the
 * check is on what is LOADED: an ESM `import` and a CommonJS `require('yjs')`
 * of that one directory are still two copies, and a nested install under a
 * dependency would be a second directory.
 *
 * In a fresh process, because `require.cache` is per process and a `bun test`
 * process holds every module its other test files loaded — a verdict here
 * would otherwise depend on which files happened to share the shard.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

interface ProbeReport {
  modules: string[];
  warnings: number;
  binImports: number;
}

async function probe(): Promise<ProbeReport> {
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'yjs-single-copy-probe.ts')], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const line = out.split('\n').find((l) => l.startsWith('YJS_PROBE '));
  if (code !== 0 || !line) throw new Error(`probe exited ${code}:\n${out}\n${err}`);
  return JSON.parse(line.slice('YJS_PROBE '.length)) as ProbeReport;
}

describe('the server module graph', () => {
  it('loads Yjs once, through every module bin.ts loads and a doc write', async () => {
    const report = await probe();
    // The probe found bin.ts's imports and loaded them; an empty scan would
    // leave server.ts alone and pass on a smaller graph than prod's.
    expect(report.binImports).toBeGreaterThan(5);
    expect(report.modules).toHaveLength(1);
    expect(report.modules[0]).toMatch(/\/yjs\/dist\/yjs\.mjs$/);
    expect(report.warnings).toBe(0);
  }, 60_000);
});
