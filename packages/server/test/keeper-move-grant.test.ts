/**
 * One passkey covers one board's move on one app for 30 minutes.
 *
 * A real listener and the real approval page, with a stand-in `fly` executor
 * and a clock the test moves. The last case drives the real `flyTarget`
 * through the keeper, so a command in the move script that the grant does not
 * cover fails here rather than as an extra tap during a move.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  projectConfig,
  secretsImportArgs,
  secretsUnsetArgs,
  volumeCreateArgs,
} from '../../../infra/project-machine/deploy-plan.ts';
import { type MoveOps, flyTarget } from '../../../infra/project-machine/move-board.ts';
import { mintCallerToken } from '../src/keeper/keeper-callers.ts';
import { keeperFly, keeperMoveGrant } from '../src/keeper/keeper-client.ts';
import { MOVE_GRANT_MS, grantCovers } from '../src/keeper/keeper-grants.ts';
import { machineShell, moveCommands, moveSteps } from '../src/keeper/keeper-move-steps.ts';
import { classifyFly } from '../src/keeper/keeper-policy.ts';
import type { Executors } from '../src/keeper/keeper-requests.ts';
import { type RunningKeeper, serveKeeper } from '../src/keeper/keeper-serve.ts';
import { type KeeperStore, hashToken, openKeeperStore } from '../src/keeper/keeper-store.ts';
import { TestPasskey } from './keeper-authenticator.ts';
import { waitFor } from './wait-for.ts';

const REPO = join(import.meta.dir, '../../..');
const APP = 'cw-harborlight';
const OTHER = 'cw-riverbend';
const BOARD = 'w-fixture1';
const tmp = mkdtempSync(join(tmpdir(), 'keeper-move-'));
const ran: string[][] = [];
/** While set, every stand-in fly call waits for it. */
let gate: Promise<void> | null = null;
const exec: Executors = {
  fly: async (args) => {
    if (gate) await gate;
    ran.push(args);
    return { status: 0, stdout: '{"holds":false}\n', stderr: '' };
  },
  cloudflare: async () => ({ status: 200, body: '{}' }),
};

let store: KeeperStore;
let CALLER = '';
let keeper: RunningKeeper;
let base: string;
let clock = Date.now();
const ORIGIN = () => keeper.origin.replace('localhost', '127.0.0.1');
const owner = new TestPasskey();

const apiHeaders = () => ({
  'content-type': 'application/json',
  'x-cw-keeper': '1',
  'x-cw-keeper-caller': CALLER,
});

/** What the keeper did with a call. `ran` waits for a call a grant started. */
async function outcome(args: string[], input?: string): Promise<'ran' | 'held' | 'refused'> {
  const res = await fetch(`${base}/v1/fly`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ args, input }),
  });
  const body = (await res.json()) as Record<string, string | boolean>;
  if (res.status === 403) return 'refused';
  if (res.status === 200) return 'ran';
  if (!body.started) return 'held';
  await waitFor(() => pollView(body).then((v) => v.status === 'done'));
  return 'ran';
}

const pollView = async (held: Record<string, string | boolean>) => {
  const res = await fetch(`${base}/v1/requests/${held.id}`, {
    headers: { ...apiHeaders(), 'x-cw-keeper-poll': String(held.pollToken) },
  });
  return (await res.json()) as { status: string; result?: { stdout: string } };
};

const askGrant = async (app: string, board: string, secrets: string[] = []) => {
  const res = await fetch(`${base}/v1/move-grant`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ app, board, secrets }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
};

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: keeper.origin },
    body: JSON.stringify(body),
  });

async function tap(id: string): Promise<Response> {
  const html = await (await fetch(`${base}/approve/${id}`)).text();
  const pageToken = /const pageToken = "([^"]+)"/.exec(html)?.[1] ?? '';
  const c = (await (await post(`/v1/requests/${id}/challenge`, { page: pageToken })).json()) as {
    challenge: string;
  };
  const assertion = owner.assert({
    challenge: c.challenge,
    origin: keeper.origin,
    rpId: 'localhost',
  });
  return post(`/v1/requests/${id}/approve`, { page: pageToken, ...assertion });
}

/** One approved grant, on a fresh keeper clock so grants of earlier cases are dead. */
async function granted(app = APP, board = BOARD, secrets: string[] = []): Promise<void> {
  clock += MOVE_GRANT_MS + 1;
  const r = await askGrant(app, board, secrets);
  expect(r.status).toBe(202);
  expect((await tap(r.body.id as string)).status).toBe(200);
}

const consoleCall = (command: string, app = APP) => [
  'ssh',
  'console',
  '--app',
  app,
  '--command',
  machineShell(command),
];
const c = moveCommands(BOARD);
const CONFIG = join(tmp, 'ctx', 'fly.toml');
const deployOn = (app: string) => ['deploy', join(tmp, 'ctx'), '--app', app, '--config', CONFIG];
const DEPLOY = deployOn(APP);

beforeAll(async () => {
  // The keeper's user reads these, as it reads a deploy's folder under /tmp.
  chmodSync(tmp, 0o755);
  mkdirSync(join(tmp, 'ctx'), { mode: 0o755 });
  writeFileSync(CONFIG, 'app = "cw-harborlight"\n', { mode: 0o644 });
  const dir = join(tmp, 'store');
  mkdirSync(dir, { mode: 0o700 });
  const opened = openKeeperStore(dir);
  if ('error' in opened) throw new Error(opened.error);
  store = opened;
  CALLER = mintCallerToken(store);
  store.addApp(APP);
  store.addApp(OTHER);
  keeper = serveKeeper({ store, exec, port: 0, now: () => clock, keeperUid: 4_000_000 });
  base = `http://127.0.0.1:${keeper.port}`;
  const token = 'enroll-test-token';
  store.saveEnroll({
    tokenHash: hashToken(token),
    expiresAt: clock + 60_000,
    createdAt: clock,
  });
  const o = (await (await post('/v1/enroll/options', { token })).json()) as {
    session: string;
    challenge: string;
  };
  const reg = owner.register({ challenge: o.challenge, origin: keeper.origin, rpId: 'localhost' });
  expect((await post('/v1/enroll', { session: o.session, ...reg })).status).toBe(200);
});

afterAll(async () => {
  await keeper.stop();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  ran.length = 0;
});

describe('asking for a move grant', () => {
  it('runs nothing, waits for the passkey, and the page names every listed step', async () => {
    const r = await askGrant(APP, BOARD);
    expect(r.status).toBe(202);
    expect(r.body.hold).toBe('move.grant');
    const html = await (await fetch(`${base}/approve/${r.body.id}`)).text();
    const text = html.replaceAll('&#39;', "'").replaceAll('&#60;', '<').replaceAll('&#62;', '>');
    for (const step of moveSteps(BOARD)) {
      expect(text.replaceAll('&#38;', '&')).toContain(step.shown);
      expect(text).toContain(step.label);
    }
    expect(text).toContain(APP);
    expect(text).toContain(BOARD);
    expect(ran).toEqual([]);
    expect((await tap(r.body.id as string)).status).toBe(200);
    expect(ran).toEqual([]);
  });

  it('is always a tap, even with a live grant on the same app and board', async () => {
    await granted();
    const again = await askGrant(APP, BOARD);
    expect(again.status).toBe(202);
  });

  it('refuses an app the keeper does not hold, and a board id that is not one', async () => {
    expect((await askGrant('cw-saltmarsh', BOARD)).status).toBe(403);
    expect((await askGrant(APP, 'w-x; rm -r /data')).status).toBe(403);
  });

  it('needs the caller token', async () => {
    const res = await fetch(`${base}/v1/move-grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cw-keeper': '1' },
      body: JSON.stringify({ app: APP, board: BOARD }),
    });
    expect(res.status).toBe(401);
  });
});

describe('what one approval covers', () => {
  it('CONTROL: without a grant, a listed step waits for the passkey', async () => {
    clock += MOVE_GRANT_MS + 1;
    expect(await outcome(consoleCall(c.holdOff))).toBe('held');
    expect(ran).toEqual([]);
  });

  it('listed steps run on the granted app with no further tap', async () => {
    await granted();
    const cfg = projectConfig({ project: 'harborlight', imageLabel: '0'.repeat(40) });
    const listed = [
      secretsUnsetArgs(APP, ['OLD_NAME']),
      volumeCreateArgs(cfg),
      consoleCall(c.holds),
      consoleCall(c.fingerprint('eyJhIjoxfQ==')),
      consoleCall('bun /app/infra/project-machine/wall-probe.ts mint'),
      consoleCall('bun /app/infra/project-machine/wall-probe.ts machine'),
      consoleCall('bun /app/infra/project-machine/wall-probe.ts verify eyJhIjoxfQ=='),
    ];
    for (const args of listed) {
      expect({ args, did: await outcome(args) }).toEqual({ args, did: 'ran' });
    }
    expect(ran.length).toBe(listed.length);
  });

  it('a step not listed is still held or refused', async () => {
    await granted();
    const heldOnes = [
      consoleCall('cat /proc/1/environ'),
      consoleCall(`${c.holds}; cat /proc/1/environ`),
      consoleCall(c.fingerprint('x; id').replace('x; id', "x'; id; '")),
      consoleCall(moveCommands('w-fixture2').holds),
      ['ssh', 'console', '--app', APP],
      ['ssh', 'sftp', 'put', CONFIG, '/etc/passwd', '--app', APP],
      ['ssh', 'sftp', 'get', '/data/cw/share-cookie.key', join(tmp, 'k'), '--app', APP],
      DEPLOY,
      ['secrets', 'set', 'A=b', '--app', APP],
      ['secrets', 'import', '--app', APP],
      ['secrets', 'unset', 'OLD_NAME', '--app', APP],
      ['machine', 'destroy', 'm1', '--app', APP, '--force'],
      ['volume', 'destroy', 'v1', '--app', APP, '--yes'],
      ['logs', '--app', APP, '--no-tail'],
      ['apps', 'create', 'cw-saltmarsh', '--org', 'test-org'],
      ['storage', 'create', '--org', 'test-org', '--name', 'cw-saltmarsh-backups', '--yes'],
    ];
    for (const args of heldOnes) {
      expect({ args, did: await outcome(args) }).toEqual({ args, did: 'held' });
    }
    const refused = [
      ['auth', 'token'],
      ['tokens', 'create', 'org'],
      ['orgs', 'invite', 'x'],
      ['ssh', 'issue', '--app', APP],
      ['status', '--app', APP, '--access-token', 'x'],
      ['status', '--app', APP, '--debug'],
    ];
    for (const args of refused) {
      expect({ args, did: await outcome(args) }).toEqual({ args, did: 'refused' });
    }
    expect(ran).toEqual([]);
  });

  it('another project is still held', async () => {
    await granted();
    const elsewhere = [
      consoleCall(c.holds, OTHER),
      deployOn(OTHER),
      ['secrets', 'unset', 'OLD_NAME', '--app', OTHER, '--stage'],
    ];
    for (const args of elsewhere) {
      expect({ args, did: await outcome(args) }).toEqual({ args, did: 'held' });
    }
    expect(ran).toEqual([]);
  });

  it('a request after 30 minutes is held, and one just inside is not', async () => {
    await granted();
    clock += MOVE_GRANT_MS - 1;
    expect(await outcome(consoleCall(c.holdOff))).toBe('ran');
    clock += 1;
    expect(await outcome(consoleCall(c.holdOff))).toBe('held');
  });

  // The keeper also sweeps expired grants, so this is the check by itself.
  it('grantCovers refuses a grant at the moment it expires', () => {
    const v = classifyFly(consoleCall(c.holdOff), [APP]);
    if (v.kind !== 'held') throw new Error('expected held');
    const grant = { scope: 'fly' as const, target: APP, board: BOARD, expiresAt: 100 };
    expect(grantCovers([grant], 'fly', v, null, 99)).toBe(true);
    expect(grantCovers([grant], 'fly', v, null, 100)).toBe(false);
  });

  it('a setup grant from a new project does not cover a move step', async () => {
    clock += MOVE_GRANT_MS + 1;
    const res = await fetch(`${base}/v1/fly`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ args: ['apps', 'create', 'cw-saltmarsh', '--org', 'test-org'] }),
    });
    const r = (await res.json()) as { id: string };
    expect((await tap(r.id)).status).toBe(200);
    expect(await outcome(['secrets', 'import', '--app', 'cw-saltmarsh'])).toBe('ran');
    expect(await outcome(deployOn('cw-saltmarsh'))).toBe('held');
  });
});

describe('secrets and sizes', () => {
  const importArgs = secretsImportArgs(APP);

  it('the page names the secrets, and an import of those runs', async () => {
    clock += MOVE_GRANT_MS + 1;
    const r = await askGrant(APP, BOARD, ['TUNNEL_NAME']);
    expect(await (await fetch(`${base}/approve/${r.body.id}`)).text()).toContain('TUNNEL_NAME');
    expect((await tap(r.body.id as string)).status).toBe(200);
    expect(await outcome(importArgs, 'TUNNEL_NAME=fixture\n')).toBe('ran');
  });

  it('an import of a name the page did not list is held', async () => {
    await granted(APP, BOARD, ['TUNNEL_NAME']);
    expect(await outcome(importArgs, 'OTHER_NAME=fixture\n')).toBe('held');
    expect(await outcome(['secrets', 'import', '--app', APP], 'TUNNEL_NAME=a\n')).toBe('held');
    expect(await outcome(importArgs, 'TUNNEL_NAME=a\nOTHER_NAME=b\n')).toBe('held');
    expect(await outcome(importArgs, 'TUNNEL_NAME=a\nnot a name line\n')).toBe('held');
    expect(await outcome(importArgs, '')).toBe('held');
  });

  it('with no names listed, no import is covered', async () => {
    await granted();
    expect(await outcome(importArgs, 'TUNNEL_NAME=fixture\n')).toBe('held');
  });

  it('a volume over the cap is held', async () => {
    await granted();
    const volume = (gb: string) => [
      'volume',
      'create',
      'cw_data',
      '--app',
      APP,
      '--region',
      'sjc',
      '--size',
      gb,
      '--yes',
    ];
    expect(await outcome(volume('50'))).toBe('ran');
    expect(await outcome(volume('51'))).toBe('held');
    expect(await outcome(['volume', 'create', 'cw_data', '--app', APP, '--yes'])).toBe('held');
  });
});

describe('a covered call that takes long', () => {
  it('answers at once and reports through the poll, so no client fetch waits on it', async () => {
    await granted();
    let finish = () => {};
    gate = new Promise((r) => {
      finish = r;
    });
    const r = await fetch(`${base}/v1/fly`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ args: consoleCall(c.importBundle) }),
    });
    const body = (await r.json()) as Record<string, string | boolean>;
    expect({ status: r.status, started: body.started }).toEqual({ status: 202, started: true });
    expect((await pollView(body)).status).toBe('running');
    finish();
    await waitFor(() => pollView(body).then((v) => v.status === 'done'));
    expect((await pollView(body)).result?.stdout).toContain('holds');
    gate = null;
  });

  it('tells nobody to tap', async () => {
    await granted();
    let told = 0;
    const done = await keeperFly(ORIGIN(), consoleCall(c.holdOff), undefined, {
      callerToken: CALLER,
      pollMs: 5,
      onHeld: () => told++,
      announce: () => told++,
    });
    expect(done.status).toBe(0);
    expect(told).toBe(0);
  });
});

describe('the real helpers, in their own process, under one grant', () => {
  it('onMachine and the wall report reach the end with nothing held', async () => {
    await granted();
    const tokenFile = join(tmp, 'caller-token');
    writeFileSync(tokenFile, CALLER, { mode: 0o600 });
    const script = join(tmp, 'drive.ts');
    writeFileSync(
      script,
      `import { onMachine } from '${REPO}/infra/project-machine/mac-ops.ts';
import { crossRows } from '${REPO}/infra/project-machine/wall-report.ts';
import { moveCommands } from '${REPO}/packages/server/src/keeper/keeper-move-steps.ts';
onMachine('${APP}', moveCommands('${BOARD}').holdOff);
crossRows(['harborlight'], onMachine);
console.log('finished');
`,
    );
    const child = Bun.spawn(['bun', script], {
      cwd: REPO,
      env: {
        ...process.env,
        CW_KEEPER_URL: ORIGIN(),
        CW_KEEPER_CALLER_TOKEN_FILE: tokenFile,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let exited = false;
    void child.exited.then(() => {
      exited = true;
    });
    const before = keeper.requests.pending().length;
    await waitFor(() => exited || keeper.requests.pending().length > before, {
      timeout: 30_000,
    });
    const heldNow = keeper.requests
      .pending()
      .slice(before)
      .map((r) => r.summary);
    if (!exited) child.kill();
    expect(heldNow).toEqual([]);
    expect(await new Response(child.stdout).text()).toContain('finished');
    const sent = ran.filter((a) => a[1] === 'console').map((a) => a[5]);
    expect(sent).toContain(machineShell(c.holdOff));
    expect(sent.some((s) => s?.includes('wall-probe.ts mint'))).toBe(true);
    expect(sent.some((s) => s?.includes('wall-probe.ts verify'))).toBe(true);
  }, 60_000);
});

describe('the move script under one grant', () => {
  it('reaches the end of a move with no held request', async () => {
    const asked = keeperMoveGrant(ORIGIN(), APP, BOARD, [], {
      callerToken: CALLER,
      pollMs: 5,
      onHeld: (held) => void tap(held.id),
    });
    expect((await asked).status).toBe(200);

    const held: string[][] = [];
    const flySync = async (args: string[]): Promise<string> => {
      if ((await outcome(args)) !== 'ran') held.push(args);
      return '{"holds":false}';
    };
    const pending: Promise<unknown>[] = [];
    const ops: MoveOps = {
      flyOk: (args) => {
        pending.push(flySync(args));
        return '';
      },
      onMachine: (app, command) => {
        pending.push(flySync(consoleCall(command, app)));
        return '{"holds":false}\n200';
      },
      keeperStage: () => ({ dir: join(tmp), share: () => {}, done: () => {} }),
      machines: () => [{ id: 'm1', state: 'started' }],
      pack: (_, tgz) => writeFileSync(tgz, 'bundle'),
      sleep: async () => {},
    };
    const target = flyTarget(APP, ops);
    await target.holds(BOARD);
    await target.importBundle(tmp, BOARD);
    await target.print(BOARD, { events: { a: 1 }, notes: {} } as never).catch(() => null);
    await Promise.all(pending);
    expect(held).toEqual([]);
    expect(ran.filter((a) => a[1] === 'console').length).toBeGreaterThanOrEqual(6);
    expect(ran.some((a) => a[1] === 'sftp')).toBe(true);
    expect(ran.some((a) => a[1] === 'restart')).toBe(true);
  });
});
