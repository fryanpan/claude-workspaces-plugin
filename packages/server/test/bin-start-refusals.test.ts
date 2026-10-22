/**
 * A REAL spawned `bin.ts`: it refuses to start without a data dir, it refuses
 * a busy port instead of moving to the next one, and — the control — it boots
 * and serves from the data dir CW_DATA_DIR alone names, which is how prod
 * names its corpus.
 *
 * Scratch data dirs only; no fixture names anybody.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readServerStarts, serverStartsPath } from '../src/server-starts.ts';
import { waitFor } from './wait-for.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BIN = join(repoRoot, 'packages', 'server', 'src', 'bin.ts');

const running: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of running.splice(0)) c.kill('SIGTERM');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'cw-bin-start-'));
  dirs.push(d);
  return d;
}

/** The environment without a data dir, so each case names its own. */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { CW_DATA_DIR: _inherited, ...rest } = process.env;
  return { ...rest, CW_SUMMARIES: '0', ...extra };
}

function start(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn('bun', ['run', BIN, ...args], {
    cwd: scratch(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  let out = '';
  child.stdout?.on('data', (b) => {
    out += String(b);
  });
  child.stderr?.on('data', (b) => {
    out += String(b);
  });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { exited, output: () => out };
}

/** A port nothing holds right now: bind 0, read it, let it go. */
function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = s.port ?? 0;
  s.stop(true);
  return port;
}

describe('bin.ts start refusals', () => {
  it('refuses to start without a data dir', async () => {
    const run = start(['--port', String(freePort())], baseEnv());
    expect(await run.exited).toBe(2);
    expect(run.output()).toContain('no data dir');
    expect(run.output()).not.toContain('listening on');
  }, 30_000);

  it('refuses a busy port instead of moving to the next one', async () => {
    const holder = Bun.serve({ port: 0, fetch: () => new Response('holder') });
    try {
      const port = holder.port ?? 0;
      const dataDir = scratch();
      const run = start(['--port', String(port), '--data-dir', dataDir], baseEnv());
      expect(await run.exited).toBe(2);
      expect(run.output()).toContain(`port ${port} is in use`);
      expect(run.output()).not.toContain('listening on');
      // The probe refuses before the server is built, so the corpus is
      // untouched beyond the start record.
      expect(existsSync(join(dataDir, 'workspaces'))).toBe(false);
    } finally {
      holder.stop(true);
    }
  }, 30_000);

  it('control: boots and serves from the data dir CW_DATA_DIR alone names', async () => {
    const dataDir = scratch();
    const port = freePort();
    start(['--port', String(port)], baseEnv({ CW_DATA_DIR: dataDir }));
    await waitFor(() => readServerStarts(serverStartsPath(dataDir)).at(-1)?.servingAt, {
      timeout: 20_000,
      interval: 100,
      describe: 'the boot to mark itself serving in the CW_DATA_DIR corpus',
    });
    const res = await fetch(`http://127.0.0.1:${port}/workspaces`, {
      headers: { host: `localhost:${port}` },
    });
    expect(res.status).toBe(200);
  }, 30_000);
});
