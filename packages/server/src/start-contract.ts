/**
 * What a supervisor start (`scripts/serve.ts`) is told to serve: which port,
 * which data dir, and whether a busy port is waited for or refuses the start.
 *
 * Pure, so prod's own start can be asserted without binding 8787 — the port
 * prod holds on the machine that runs the tests. Prod's launchd job runs
 * `bun run scripts/serve.ts --no-watch` with `CW_DATA_DIR` set and no port
 * variable, and nobody can edit that plist from a PR, so this module must
 * keep reading that start as port 8787 on the CW_DATA_DIR corpus.
 *
 * The port keeps its 8787 default because that plist names none. The data
 * dir has no default (data-dir.ts says why), and no start moves to another
 * port (port-bind.ts says why).
 */
import { MISSING_DATA_DIR, dataDirFromArgs } from './data-dir.ts';
import { waitsForItsPort } from './port-bind.ts';

/** The port a start that names none listens on: prod's. */
export const DEFAULT_PORT = 8787;

export type StartContract =
  | { ok: true; port: number; dataDir: string; waitsForPort: boolean }
  | { ok: false; error: string };

export function resolveStartContract(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): StartContract {
  // The LAST occurrence wins, so `bun run dev --data-dir x` overrides the
  // `--data-dir data` the dev script already passes.
  const arg = (name: string): string | undefined => {
    const i = argv.lastIndexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataDir = dataDirFromArgs(env, arg);
  if (!dataDir) return { ok: false, error: MISSING_DATA_DIR };
  const raw = arg('port') ?? env.PORT?.trim() ?? String(DEFAULT_PORT);
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65_535) {
    return { ok: false, error: `--port ${raw} is not a port number (0-65535)` };
  }
  return { ok: true, port, dataDir, waitsForPort: waitsForItsPort(argv) };
}
