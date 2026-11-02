/**
 * The setup step that gives the keeper's callers their token
 * (`keeper-callers.ts`): kept when the keeper still accepts it, otherwise
 * minted by the keeper and written, mode 600, to the caller token file under
 * Bryan's own prod root. Runs as Bryan, from `keeper-setup.ts`.
 *
 * The token reaches this process on the keeper's stdout and leaves it only
 * into that file: never an argument, a log line or a printed line.
 */
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
