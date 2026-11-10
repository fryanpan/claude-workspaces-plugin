/**
 * The setup step that gives the keeper's callers their token
 * (`keeper-callers.ts`): kept when the keeper still accepts it, otherwise
 * minted by the keeper and written, mode 600, to the caller token file under
 * Bryan's own prod root. Runs as Bryan, from `keeper-setup.ts`.
 *
 * The token reaches this process on the keeper's stdout and leaves it only
 * into that file: never an argument, a log line or a printed line.
 *
 * Also the two file helpers step 4 uses to point the callers at the keeper's
 * URL: the plist edit and the one-rename write.
 */
import { chmodSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { CALLER_HEADER, readCallerToken, writeCallerToken } from './keeper-callers.ts';
import { API_HEADER } from './keeper-http.ts';

export interface CallerStepDeps {
  /** The caller token file. */
  path: string;
  /** The keeper's origin. */
  url: string;
  dryRun: boolean;
  fetch: typeof fetch;
  /** Runs `keeper-bin.ts caller-token` as the keeper's user. */
  mint: () => { status: number; stdout: string; stderr: string };
}

export type CallerStep =
  | { token: string; said: string }
  | { token: null; would: string }
  | { stop: string };

/** A request id no request has: 404 means the token was accepted, 401 that it was not. */
const NO_SUCH = 'caller-check';

async function accepted(d: CallerStepDeps, token: string): Promise<boolean> {
  const res = await d.fetch(`${d.url}/v1/requests/${NO_SUCH}`, {
    headers: { [API_HEADER]: '1', [CALLER_HEADER]: token },
  });
  return res.status === 404;
}

export async function ensureCallerToken(d: CallerStepDeps): Promise<CallerStep> {
  const held = readCallerToken(d.path);
  // A dry run reads no credential, so it does not ask the keeper either.
  if ('token' in held && !d.dryRun && (await accepted(d, held.token))) {
    return { token: held.token, said: `${d.path} holds the keeper's caller token already` };
  }
  if (d.dryRun) {
    return { token: null, would: `make a caller token and write it, mode 600, to ${d.path}` };
  }
  const r = d.mint();
  const token = r.stdout.trim();
  if (r.status !== 0 || !token) {
    return { stop: `the keeper did not make a caller token: ${r.stderr.trim()}` };
  }
  try {
    writeCallerToken(d.path, token);
  } catch (err) {
    return { stop: `could not write ${d.path}: ${err instanceof Error ? err.message : err}` };
  }
  if (!(await accepted(d, token))) {
    return { stop: `the keeper did not accept the caller token it just made (${d.path})` };
  }
  return { token, said: `wrote the keeper's caller token to ${d.path}, mode 600` };
}

/** The plist with CW_KEEPER_URL set in EnvironmentVariables, or null when it has none. */
export function withKeeperUrl(xml: string, url: string): string | null {
  const existing = /(<key>CW_KEEPER_URL<\/key>\s*<string>)[^<]*(<\/string>)/;
  if (existing.test(xml)) return xml.replace(existing, `$1${url}$2`);
  const dict = /(<key>EnvironmentVariables<\/key>\s*<dict>)(\s*)/;
  const m = dict.exec(xml);
  if (!m) return null;
  const indent = m[2] ?? '\n        ';
  return xml.replace(
    dict,
    `$1${indent}<key>CW_KEEPER_URL</key>${indent}<string>${url}</string>${indent}`,
  );
}

/** Replace a file in one rename, keeping its mode (600 for a new one). */
export function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.keeper-setup.tmp`;
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}
