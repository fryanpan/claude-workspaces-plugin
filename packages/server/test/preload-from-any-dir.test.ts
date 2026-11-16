/**
 * A server test run from the repo root, packages/server or packages/server/test
 * loads the same preloads.
 *
 * Bun reads only the bunfig.toml in the directory it starts in. Before
 * packages/server had one, `bun test` started there loaded no preload: test
 * servers bound every interface, another process's 127.0.0.1 listener
 * answered, and tests failed on a fixture's bare `not found` 404.
 *
 * Each case starts a child `bun test` on a probe file with the preloads'
 * variables removed from its environment, so only a preload can put them
 * back, and reads what the probe printed.
 */
import { describe, expect, it } from 'bun:test';
import { join, resolve } from 'node:path';

const server = resolve(import.meta.dir, '..');
const root = resolve(server, '../..');
const probe = join(server, 'test/fixtures/preload-probe/env.probe.ts');

async function preloadsSeenFrom(cwd: string): Promise<unknown> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of ['CW_TEST_SUITE_PRELOADED', 'CW_TEST_BIND_HOST', 'CW_TEST_TIMING_SCALE']) {
    delete env[k];
  }
  const child = Bun.spawn([process.execPath, 'test', probe], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  const line = `${out}\n${err}`.split('\n').find((l) => l.startsWith('PRELOAD-PROBE '));
  if (!line) throw new Error(`the probe printed nothing from ${cwd}:\n${out}\n${err}`);
  return JSON.parse(line.slice('PRELOAD-PROBE '.length));
}

const LOADED = ['1', '127.0.0.1', '0.1'];

describe('the server suite preloads, by the directory bun test starts in', () => {
  for (const [name, dir] of [
    ['the repo root', root],
    ['packages/server', server],
    ['packages/server/test', join(server, 'test')],
  ] as const) {
    it(`loads them from ${name}`, async () => {
      expect(await preloadsSeenFrom(dir)).toEqual(LOADED);
    }, 30_000);
  }

  // The control: a directory with no bunfig.toml loads none, so the cases
  // above are the bunfigs' doing and not something the child inherited.
  it('loads none from a directory with no bunfig.toml', async () => {
    expect(await preloadsSeenFrom(join(server, 'src'))).toEqual([null, null, null]);
  }, 30_000);
});
