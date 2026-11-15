/**
 * Make, build and run an app from the app kit, for the tests that check what
 * `bun run new-app` hands an agent.
 *
 * The made app gets no `bun install`: a test must not reach the registry.
 * The app kit package is installed from the tarball the generator put in
 * `vendor/`, unpacked where `bun install` would put it, so what runs is what
 * was packed. Every other dependency the app declares is linked, one by one,
 * to the copy the template's own workspace install holds. Only the declared
 * ones, so an import the made app forgot to declare, or one left pointing
 * back into this repo, fails to resolve here as it would in a fresh
 * repository.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '..');
const TEMPLATE_MODULES = join(REPO, 'templates/app-kit/node_modules');

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
}

/** Run the generator into `<parent>/<name>`, link its dependencies, build it. */
export function makeBuiltApp(parent: string, name = 'riverbend-notes'): string {
  const dir = join(parent, name);
  run('bun', [join(REPO, 'scripts/new-app.ts'), dir], REPO);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const [dep, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const at = join(dir, 'node_modules', dep);
    mkdirSync(dirname(at), { recursive: true });
    if (spec.startsWith('file:') && spec.endsWith('.tgz')) {
      mkdirSync(at);
      run(
        'tar',
        ['-xzf', join(dir, spec.slice('file:'.length)), '-C', at, '--strip-components', '1'],
        dir,
      );
    } else symlinkSync(join(TEMPLATE_MODULES, dep), at, 'dir');
  }
  run('bun', ['run', 'build'], dir);
  return dir;
}

export interface RunningApp {
  base: string;
  ws: (docId: string) => string;
  /** The link in the latest mail of `kind` the app printed for `to`, once it
   *  has printed one (the kit's mailer prints each mail as a line). */
  mailLink: (kind: string, to: string) => Promise<string>;
  /** SIGTERM: the app saves every open doc, then exits. */
  stop: () => Promise<void>;
}

/** Start a made app on a free port; resolves once it prints its address. */
export function startApp(dir: string, dataDir: string): Promise<RunningApp> {
  const child: ChildProcess = spawn('bun', ['run', 'src/server.ts'], {
    cwd: dir,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  let out = '';
  const watchers = new Set<() => void>();
  const onOutput = (d: Buffer): void => {
    out += String(d);
    for (const w of [...watchers]) w();
  };
  child.stdout?.on('data', onOutput);
  child.stderr?.on('data', onOutput);

  /** Resolves with `find(out)` once it is not null; rejects after 10s. */
  const when = <T>(find: () => T | null, what: string): Promise<T> =>
    new Promise((resolve, reject) => {
      const check = (): void => {
        const found = find();
        if (found === null) return;
        watchers.delete(check);
        clearTimeout(timer);
        resolve(found);
      };
      const timer = setTimeout(() => {
        watchers.delete(check);
        reject(new Error(`the app never printed ${what}:\n${out}`));
      }, 10_000);
      watchers.add(check);
      check();
    });

  const started = when(() => /listening on (http:\/\/\S+)/.exec(out)?.[1] ?? null, 'its address');
  const died = new Promise<never>((_, reject) =>
    child.once('exit', (code) => reject(new Error(`the app exited (${code}):\n${out}`))),
  );
  return Promise.race([started, died]).then((base) => ({
    base,
    ws: (docId) => `${base.replace(/^http/, 'ws')}/docs/${docId}/ws`,
    mailLink: (kind, to) =>
      when(() => {
        const lines = out.split('\n').filter((l) => l.startsWith(`[mail:${kind}] to=${to} `));
        return lines.at(-1)?.split(' ').at(-1) ?? null;
      }, `a ${kind} mail to ${to}`),
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
    },
  }));
}

export const PASSWORD = 'correct horse battery staple';

/** POST a form the way the app's page does: from the app's own origin. */
export function postForm(base: string, path: string, fields: Record<string, string>, cookie = '') {
  return fetch(`${base}${path}`, {
    method: 'POST',
    body: new URLSearchParams(fields),
    headers: { origin: base, ...(cookie ? { cookie } : {}) },
    redirect: 'manual',
  });
}

/** The Cookie header that sends back every cookie a response set. */
export function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .join('; ');
}

/** Sign in on the app's form; returns the Cookie header to send. */
export async function signIn(app: RunningApp, email: string, password = PASSWORD): Promise<string> {
  const res = await postForm(app.base, '/auth/sign-in', { email, password });
  if (res.status !== 303) throw new Error(`sign-in answered ${res.status}: ${await res.text()}`);
  return cookieFrom(res);
}

/** Make an account, follow the mailed verification link, sign in. */
export async function signUpVerified(
  app: RunningApp,
  email: string,
  name: string,
): Promise<string> {
  const res = await postForm(app.base, '/auth/sign-up', { name, email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`sign-up answered ${res.status}: ${await res.text()}`);
  const verified = await fetch(await app.mailLink('verify-email', email), { redirect: 'manual' });
  if (verified.status >= 400) throw new Error(`verification answered ${verified.status}`);
  return signIn(app, email);
}
