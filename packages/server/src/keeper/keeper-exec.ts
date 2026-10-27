/**
 * How the keeper runs what it allowed: `fly` with the org token in its
 * environment, and the Cloudflare API with the token in a header.
 *
 * A credential goes into a child's environment or a request header and
 * nowhere else: never an argument (`ps` shows arguments to every user),
 * never a log line. The child's environment is built from nothing, not
 * copied from the keeper's, so it carries the one token it needs and a PATH
 * of the fly binary's own folder and the system's.
 */
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import type { GuardedFetch } from '../outbound-fetch.ts';
import type { CloudflareResult, Executors, FlyResult } from './keeper-requests.ts';
import type { KeeperStore } from './keeper-store.ts';

const MAX_OUTPUT = 16 * 1024 * 1024;
/** The longest the keeper lets one `fly` run before it kills it. */
export const FLY_TIMEOUT_MS = 30 * 60_000;
const CF_API = 'https://api.cloudflare.com/client/v4';

export function runFly(
  flyBin: string,
  home: string,
  token: string,
  args: string[],
  input: string | undefined,
): Promise<FlyResult> {
  return new Promise((resolve) => {
    const child = spawn(flyBin, args, {
      env: {
        PATH: `${dirname(flyBin)}:/usr/bin:/bin`,
        HOME: home,
        FLY_API_TOKEN: token,
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: FLY_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT) stderr += String(d);
    });
    child.on('error', (err) => resolve({ status: 127, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

export function keeperExecutors(opts: {
  store: KeeperStore;
  flyBin: string;
  home: string;
  fetch: GuardedFetch;
}): Executors {
  return {
    fly(args, input) {
      const token = opts.store.credentials().fly?.orgToken;
      if (!token)
        return Promise.resolve({ status: 1, stdout: '', stderr: 'the keeper holds no Fly token' });
      return runFly(opts.flyBin, opts.home, token, args, input);
    },
    async cloudflare(method, path, body): Promise<CloudflareResult> {
      const token = opts.store.credentials().cloudflare?.apiToken;
      if (!token)
        return {
          status: 503,
          body: JSON.stringify({ error: 'the keeper holds no Cloudflare token' }),
        };
      const res = await opts.fetch(`${CF_API}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body ? { body } : {}),
      });
      return { status: res.status, body: await res.text() };
    },
  };
}
