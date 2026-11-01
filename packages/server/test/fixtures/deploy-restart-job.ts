/**
 * A stand-in for the launchd job, driven by `deploy-restart.test.ts`.
 *
 * It does what `bin.ts` does on a stop: SIGTERM runs a graceful shutdown and
 * exits with `shutdownExitCode()`. Each start appends a line to the log the
 * test reads. Modes (argv[3]):
 *
 *   deploy  ask for a deploy restart, as `runDeploy` does after a pull
 *   hang    the same, but the shutdown never finishes (exercises the backstop)
 *   idle    ask for nothing; the test stops it with a plain SIGTERM
 */
import { appendFileSync } from 'node:fs';
import { selfRestart, shutdownExitCode } from '../../src/deploy-restart.ts';

const [logFile, mode] = process.argv.slice(2);
if (!logFile || !mode) throw new Error('usage: deploy-restart-job.ts <log> <mode>');

appendFileSync(logFile, `start ${process.pid}\n`);

process.on('SIGTERM', () => {
  if (mode === 'hang') return;
  appendFileSync(logFile, `stop ${process.pid} code=${shutdownExitCode()}\n`);
  process.exit(shutdownExitCode());
});

// What keeps the real server alive: an open listener. Without it the
// restart's unref'd timer would let this process end on its own.
setInterval(() => {}, 60_000);

if (mode === 'deploy') selfRestart(0)();
if (mode === 'hang')
  selfRestart(0, {
    stop: () => process.kill(process.pid, 'SIGTERM'),
    exit: (code) => process.exit(code),
    deadlineMs: 50,
  })();
