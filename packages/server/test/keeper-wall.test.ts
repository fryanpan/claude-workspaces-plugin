/**
 * What a local process that is not Bryan's own cannot get from the keeper's
 * agent API, and what the approval page shows before a tap
 * (`keeper-http.ts`, `keeper-callers.ts`, `keeper-policy.ts`,
 * `keeper-page.ts`).
 *
 * A. An agent-API call without the caller token is refused and runs
 *    nothing, a wrong token likewise, and the right one runs (the control).
 * B. `fly logs` waits for a passkey on every app, the keeper's own included.
 * C. The approval page shows every argument whole, so a `--command` value
 *    cannot pass for more flags, and names the command a held shell runs.
 *
 * A real listener with stand-in executors; nothing reaches Fly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyFly } from '../src/keeper/keeper-policy.ts';
import type { Executors } from '../src/keeper/keeper-requests.ts';
import { type RunningKeeper, serveKeeper } from '../src/keeper/keeper-serve.ts';
import { type KeeperStore, openKeeperStore } from '../src/keeper/keeper-store.ts';

const tmp = mkdtempSync(join(tmpdir(), 'keeper-wall-'));
const ran: string[][] = [];
const exec: Executors = {
  fly: async (args) => {
    ran.push(args);
    return { status: 0, stdout: 'ok\n', stderr: '' };
  },
  cloudflare: async () => ({ status: 200, body: '{"success":true,"result":[]}' }),
};

let store: KeeperStore;
let keeper: RunningKeeper;
let base = '';

const fly = (args: string[], headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/fly`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cw-keeper': '1', ...headers },
    body: JSON.stringify({ args }),
  });

beforeAll(() => {
  const dir = join(tmp, 'store');
  mkdirSync(dir, { mode: 0o700 });
  const s = openKeeperStore(dir);
  if ('error' in s) throw new Error(s.error);
  store = s;
  store.addApp('cw-harborlight');
  keeper = serveKeeper({ store, exec, port: 0, keeperUid: 4_000_000 });
  base = `http://127.0.0.1:${keeper.port}`;
});
afterAll(async () => {
  await keeper.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('A. the agent API needs the caller token', () => {
  it('refuses a routine call before any token exists, and runs nothing', async () => {
    const before = ran.length;
    const res = await fly(['machine', 'restart', 'm1', '--app', 'cw-harborlight']);
    expect(res.status).toBe(401);
    expect(ran.length).toBe(before);
    const cf = await fetch(`${base}/v1/cloudflare/zones`, { headers: { 'x-cw-keeper': '1' } });
    expect(cf.status).toBe(401);
  });

  it('refuses a wrong token, and runs the call with the right one', async () => {
    const { mintCallerToken } = await import('../src/keeper/keeper-callers.ts');
    const token = mintCallerToken(store);
    const args = ['machine', 'restart', 'm1', '--app', 'cw-harborlight'];
    const before = ran.length;
    const wrong = await fly(args, { 'x-cw-keeper-caller': `${token.slice(0, -2)}xx` });
    expect(wrong.status).toBe(401);
    expect(ran.length).toBe(before);
    const right = await fly(args, { 'x-cw-keeper-caller': token });
    expect(right.status, await right.clone().text()).toBe(200);
    expect(ran.at(-1)).toEqual(args);
    // A newer token retires the older one.
    const next = mintCallerToken(store);
    expect((await fly(args, { 'x-cw-keeper-caller': token })).status).toBe(401);
    expect((await fly(args, { 'x-cw-keeper-caller': next })).status).toBe(200);
  });
});

describe('B. fly logs', () => {
  it('waits for a passkey on every app, the keeper’s own included', () => {
    for (const app of ['cw-harborlight', 'cw-riverbend']) {
      expect(classifyFly(['logs', '--app', app, '--no-tail'], ['cw-harborlight'])).toMatchObject({
        kind: 'held',
        app,
      });
    }
  });
});

describe('C. the approval page', () => {
  it('shows every argument whole, and the command a held shell runs', async () => {
    const { mintCallerToken } = await import('../src/keeper/keeper-callers.ts');
    const token = mintCallerToken(store);
    const command = 'env; cat /data/cw/secrets --app cw-riverbend';
    const res = await fly(['ssh', 'console', '--app', 'cw-harborlight', '--command', command], {
      'x-cw-keeper-caller': token,
    });
    const held = (await res.json()) as { id: string; summary: string };
    expect(res.status, JSON.stringify(held)).toBe(202);
    // One argument, quoted as one: not a second --app.
    expect(held.summary).toBe(
      `fly ssh console --app cw-harborlight --command 'env; cat /data/cw/secrets --app cw-riverbend'`,
    );
    const html = await (await fetch(`${base}/approve/${held.id}`)).text();
    const remote = /<pre id="remote">([^<]*)<\/pre>/.exec(html)?.[1];
    expect(remote).toBe(command);
    const args = [...html.matchAll(/<li><code>([^<]*)<\/code><\/li>/g)].map((m) => m[1]);
    expect(args).toEqual([
      'ssh',
      'console',
      '--app',
      'cw-harborlight',
      '--command',
      '&#39;env; cat /data/cw/secrets --app cw-riverbend&#39;',
    ]);
  });

  it('shows a character that draws as nothing, or reverses text, as its escape', async () => {
    const { mintCallerToken } = await import('../src/keeper/keeper-callers.ts');
    const token = mintCallerToken(store);
    const res = await fly(['ssh', 'console', '--app', 'cw-harborlight', '--command', 'ls‮;id'], {
      'x-cw-keeper-caller': token,
    });
    const held = (await res.json()) as { summary: string };
    expect(held.summary).toEndWith(`--command $'ls\\u202e;id'`);
  });
});
