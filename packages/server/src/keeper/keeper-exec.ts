/**
 * How the keeper runs what it allowed: `fly` with the org token in its
 * environment, the Cloudflare API with the token in a header, and the
 * Cloudflare Terraform run (`infra/cloudflare/keeper-run.ts`, from the
 * keeper's own release) with the token in its environment.
 *
 * A credential goes into a child's environment or a request header and
 * nowhere else: never an argument (`ps` shows arguments to every user),
 * never a log line. The child's environment is built from nothing, not
 * copied from the keeper's, so it carries the one token it needs and a PATH
 * of the fly binary's own folder and the system's.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GuardedFetch } from '../outbound-fetch.ts';
import { ed25519Pair, makePushKeys } from './keeper-push-keys.ts';
import type { CloudflareResult, Executors, FlyResult } from './keeper-requests.ts';
import type { KeeperStore } from './keeper-store.ts';
import type { TerraformEnv, TerraformMode } from './keeper-terraform.ts';

const MAX_OUTPUT = 16 * 1024 * 1024;
/** The longest the keeper lets one `fly` run before it kills it. */
export const FLY_TIMEOUT_MS = 30 * 60_000;
const CF_API = 'https://api.cloudflare.com/client/v4';
const GITHUB_API = 'https://api.github.com';

export function runFly(
  flyBin: string,
  home: string,
  token: string,
  args: string[],
  input: string | undefined,
): Promise<FlyResult> {
  return runChild(
    flyBin,
    args,
    { PATH: `${dirname(flyBin)}:/usr/bin:/bin`, HOME: home, FLY_API_TOKEN: token, NO_COLOR: '1' },
    input,
  );
}

/** Where the keeper's Terraform run finds what it runs, all of it the keeper's own. */
export interface TerraformSetup {
  /** The release's root: `keeper-run.ts` and the `.tf` files under `infra/cloudflare`. */
  root: string;
  /** The fixed terraform binary, beside `bun` and `fly`. */
  terraformBin: string;
  /** A folder of the keeper's own, mode 700: tfvars, saved plans, providers. */
  workDir: string;
  /** The bun that runs the keeper. */
  bunBin: string;
}

/**
 * One `keeper-run.ts <mode> <env>`, the requester's input on stdin. The
 * environment is built from nothing: the token, the fixed binary and the
 * work folder, so nothing in it came from a requester.
 */
export function runTerraform(
  setup: TerraformSetup,
  home: string,
  token: string,
  mode: TerraformMode,
  env: TerraformEnv,
  stdin: string,
): Promise<FlyResult> {
  mkdirSync(setup.workDir, { recursive: true, mode: 0o700 });
  return runChild(
    setup.bunBin,
    [join(setup.root, 'infra', 'cloudflare', 'keeper-run.ts'), mode, env],
    {
      PATH: '/usr/bin:/bin',
      HOME: home,
      CLOUDFLARE_API_TOKEN: token,
      CW_TERRAFORM_BIN: setup.terraformBin,
      CW_TF_WORK_DIR: setup.workDir,
      NO_COLOR: '1',
    },
    stdin,
    setup.root,
  );
}

function runChild(
  bin: string,
  args: string[],
  env: Record<string, string>,
  input: string | undefined,
  cwd?: string,
): Promise<FlyResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      env,
      ...(cwd ? { cwd } : {}),
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
  /** Without it the keeper answers every Terraform request with an error. */
  terraform?: TerraformSetup;
}): Executors {
  /** One Terraform run at a time: two would share the work folder. */
  let tfLane: Promise<unknown> = Promise.resolve();
  const exec: Executors = {
    terraform(mode, env, stdin) {
      const token = opts.store.credentials().cloudflare?.apiToken;
      const setup = opts.terraform;
      if (!token || !setup) {
        const why = token ? 'the keeper has no terraform' : 'the keeper holds no Cloudflare token';
        return Promise.resolve({ status: 1, stdout: '', stderr: why });
      }
      const next = tfLane.then(() => runTerraform(setup, opts.home, token, mode, env, stdin));
      tfLane = next.catch(() => {});
      return next;
    },
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
    async pushKeys(app, repos): Promise<CloudflareResult> {
      const token = opts.store.credentials().github?.token;
      if (!token)
        return { status: 503, body: JSON.stringify({ error: 'the keeper holds no GitHub token' }) };
      return makePushKeys(
        {
          github: async (method, path, body) => {
            const res = await opts.fetch(`${GITHUB_API}${path}`, {
              method,
              headers: {
                authorization: `Bearer ${token}`,
                accept: 'application/vnd.github+json',
                'x-github-api-version': '2022-11-28',
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: res.status, body: await res.text() };
          },
          keygen: async (comment) => ed25519Pair(comment),
          fly: (args, input) => exec.fly(args, input),
        },
        app,
        repos,
      );
    },
  };
  return exec;
}
