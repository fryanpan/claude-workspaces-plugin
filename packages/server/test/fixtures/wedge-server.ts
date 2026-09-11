/**
 * Child-process fixture for supervisor-wedge.test.ts: the real server, on a
 * throwaway data dir, that stops running JavaScript when told to. Run with
 * `bun run`, never as a test — the wedge must live in its own process, since
 * a blocked loop in the test runner would block the probes too.
 *
 *   argv[2]      the data dir
 *   stdout       `ready <port>` once bound; `wedged` just before blocking
 *   stdin        `wedge` → block the main thread until the process is killed
 *
 * The block is `Atomics.wait` with no timeout: a genuine synchronous stop of
 * the main thread, like the synchronous file open that parked prod on
 * 2026-09-04, without spinning a core while the test reads it.
 */
import { writeSync } from 'node:fs';
import { Deployer } from '../../src/deploy.ts';
import { createServer } from '../../src/server.ts';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('usage: wedge-server.ts <dataDir>');

const handle = createServer({
  port: 0,
  dataDir,
  // The probe's route answers from the deployer; this one can never deploy.
  deployer: new Deployer({
    run: async () => {
      throw new Error('fixture: deploys are not possible here');
    },
  }),
});
writeSync(1, `ready ${handle.port}\n`);

process.stdin.on('data', (chunk) => {
  if (!String(chunk).includes('wedge')) return;
  // Synchronous, so the line is out before the block and nothing the loop
  // could do runs between the two.
  writeSync(1, 'wedged\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
