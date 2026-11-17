/**
 * Boots the real `bin.ts` in a child process, on a port the child picks
 * itself, and returns once that child says where it is listening.
 *
 * The tests that did this used to free a port with a probe server, hand the
 * number to the child, and take the server as up once anything answered
 * there. Several server-test processes run at once on a CI runner, and
 * another one's server could bind the freed port in the gap. This child then
 * refused the busy port and exited, unheard behind `stdio: 'ignore'`, and the
 * test talked to the other server: the restore test's docs persisted into
 * somebody else's data dir (CI runs 43568353533, 43872947523) or the other
 * server stopped mid-test and the next call was refused (43772284302); the
 * move-board test read a 404 for its own board (43395696747, 43605410257).
 * The move-board test fixed this for itself first; this is that fix, shared.
 * Port 0 leaves no gap, and reading the port off the child's own "listening
 * on" line means nothing else can answer for it.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor } from './wait-for.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface BootedBin {
  base: string;
  port: number;
  child: ChildProcess;
}

export interface BootBinOpts {
  dataDir: string;
  /** Added to the child's environment, over this process's own. */
  env?: Record<string, string>;
  /** Every child is pushed here, so an `afterAll` can kill what is left. */
  children?: ChildProcess[];
}

export async function bootBin(opts: BootBinOpts): Promise<BootedBin> {
  const child = spawn(
    'bun',
    [
      'run',
      join(repoRoot, 'packages', 'server', 'src', 'bin.ts'),
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      '--data-dir',
      opts.dataDir,
    ],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CW_SUMMARIES: '0', ...opts.env },
    },
  );
  opts.children?.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (b: Buffer) => {
    stdout += b.toString();
  });
  child.stderr?.on('data', (b: Buffer) => {
    stderr += b.toString();
  });
  // A child that dies will never say where it listens; name why at once
  // rather than waiting out the timeout.
  let listening = false;
  const died = new Promise<never>((_, reject) => {
    child.once('exit', (code, signal) => {
      if (!listening)
        reject(new Error(`bin.ts exited ${code ?? signal} before listening:\n${stderr}`));
    });
  });
  // An exit after the wait already failed is not a second error.
  died.catch(() => {});
  const port = await Promise.race([
    waitFor(() => stdout.match(/listening on :(\d+)\r?\n/)?.[1], {
      timeout: 30_000,
      interval: 50,
      describe: 'the server to say where it listens',
    }),
    died,
  ]);
  listening = true;
  return { base: `http://127.0.0.1:${port}`, port: Number(port), child };
}

export async function stopBin(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  child.kill('SIGTERM');
  await exited;
}
