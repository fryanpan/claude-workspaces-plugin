/**
 * Make, build and run an app from the app kit, for the tests that check what
 * `bun run new-app` hands an agent.
 *
 * The made app gets no `bun install`: a test must not reach the registry.
 * Instead each dependency the app declares is linked, one by one, to the copy
 * the template's own workspace install holds. Only the declared ones, so an
 * import the made app forgot to declare, or one left pointing back into this
 * repo, fails to resolve here exactly as it would in a fresh repository.
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
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const link = join(dir, 'node_modules', dep);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(TEMPLATE_MODULES, dep), link, 'dir');
  }
  run('bun', ['run', 'build'], dir);
  return dir;
}

export interface RunningApp {
  base: string;
  ws: (docId: string) => string;
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
  return new Promise((resolveStart, reject) => {
    let out = '';
    const onData = (d: Buffer): void => {
      out += String(d);
      const m = /listening on (http:\/\/\S+)/.exec(out);
      if (!m?.[1]) return;
      child.stdout?.off('data', onData);
      const base = m[1];
      resolveStart({
        base,
        ws: (docId) => `${base.replace(/^http/, 'ws')}/docs/${docId}/ws`,
        stop: async () => {
          if (child.exitCode === null) child.kill('SIGTERM');
          await exited;
        },
      });
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (d) => {
      out += String(d);
    });
    child.once('exit', (code) =>
      reject(new Error(`the app exited (${code}) before listening:\n${out}`)),
    );
  });
}

/** Sign in through the app's own form; returns the Cookie header to send. */
export async function signInAs(base: string, name: string): Promise<string> {
  const res = await fetch(`${base}/auth/sign-in`, {
    method: 'POST',
    body: new URLSearchParams({ name }),
    redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  if (res.status !== 303 || !set) throw new Error(`sign-in answered ${res.status}`);
  return set.split(';')[0] ?? '';
}
