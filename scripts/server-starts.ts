/**
 * The uptime step of the daily health check, as one command: how many times
 * the server started in the window, and how many of those a deploy, the
 * watchdog or a host reboot explains. The rest are crashes to root-cause.
 *
 *   bun run starts:report --data-dir <data> [--hours 24] [--json]
 *
 * `--data-dir` defaults the way the server's does (`CW_DATA_DIR`, else the
 * checkout's `data/`), so pass prod's explicitly from a dev checkout. Exits 2
 * when the data dir holds no start record at all — an absent record is a
 * wrong path or an old server, never a clean day.
 *
 * The logic is `packages/server/src/server-starts.ts`; this only reads files.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from '../packages/server/src/data-dir.ts';
import { deployLogPath, readDeployLogEntries } from '../packages/server/src/deploy-log.ts';
import {
  formatStartsReport,
  readServerStarts,
  serverStartsPath,
  summarizeStarts,
} from '../packages/server/src/server-starts.ts';

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = arg('data-dir') ?? resolveDataDir(process.env, repoRoot);
const hours = Number(arg('hours') ?? '24');
if (!Number.isFinite(hours) || hours <= 0) {
  console.error('--hours must be a positive number');
  process.exit(2);
}

const file = serverStartsPath(dataDir);
const until = Date.now();
const summary = summarizeStarts({
  starts: readServerStarts(file),
  deploys: readDeployLogEntries(deployLogPath(dataDir)),
  since: until - hours * 60 * 60_000,
  until,
});
console.log(
  args.includes('--json') ? JSON.stringify(summary, null, 2) : formatStartsReport(summary, file),
);
process.exit(summary.recordedFrom === null ? 2 : 0);
