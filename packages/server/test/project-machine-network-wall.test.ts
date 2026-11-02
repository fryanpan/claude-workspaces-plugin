/**
 * The network wall check (`infra/project-machine/network-wall.ts`), driven
 * against a fake `fly` that answers like a Fly org. Nothing here calls Fly.
 *
 * The fake models the networks: a probe connects when the two apps share a
 * network, and is refused otherwise. Each case breaks one part of that and
 * checks the verdict follows.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { RunResult } from '../../../infra/project-machine/mac-ops.ts';
import {
  PROBES,
  WALL_APPS,
  readOutcome,
  table,
} from '../../../infra/project-machine/network-wall-plan.ts';
import {
  type FlyRunner,
  dryRunner,
  runNetworkWall,
} from '../../../infra/project-machine/network-wall.ts';

interface Fake {
  run: FlyRunner;
  calls: string[][];
  /** Apps that exist now. */
  apps: Set<string>;
}

const net = (app: string) => WALL_APPS.find((a) => a.app === app)?.network ?? '';

/**
 * `answer(fromApp, toApp, sameNetwork)` decides what a probe prints;
 * `fail(args)` makes one command fail.
 */
function fakeFly(
  opts: {
    answer?: (from: string, to: string, same: boolean) => string;
    fail?: (args: string[]) => boolean;
    existing?: string[];
  } = {},
): Fake {
  const apps = new Set(opts.existing ?? []);
  const calls: string[][] = [];
  const answer =
    opts.answer ?? ((_f: string, _t: string, same: boolean) => (same ? 'connected' : 'timeout'));
  const ipOf = (app: string) => `fdaa:0:${WALL_APPS.findIndex((a) => a.app === app) + 1}::2`;
  const res = (stdout: string, status = 0): RunResult => ({ status, stdout, stderr: '' });
  const run: FlyRunner = (args) => {
    calls.push(args);
    if (opts.fail?.(args)) return { status: 1, stdout: '', stderr: 'fixture failure' };
    const app = args[args.indexOf('--app') + 1] ?? '';
    const [a, b] = args;
    if (a === 'apps' && b === 'list')
      return res(JSON.stringify([...apps].map((Name) => ({ Name }))));
    if (a === 'apps' && b === 'create') {
      apps.add(args[2] ?? '');
      return res('');
    }
    if (a === 'apps' && b === 'destroy') {
      apps.delete(args[2] ?? '');
      return res('');
    }
    if (a === 'machine' && b === 'run') return res('');
    if (a === 'machine' && b === 'list')
      return res(JSON.stringify([{ id: `m-${app}`, private_ip: ipOf(app) }]));
    if (a === 'machine' && b === 'exec') {
      const host = (args[3] ?? '').split(' ')[3] ?? '';
      const to =
        WALL_APPS.find((w) => host === `${w.app}.internal` || host === ipOf(w.app))?.app ?? '';
      return res(`result=${answer(app, to, net(app) === net(to))}\n`);
    }
    return res('');
  };
  return { run, calls, apps };
}

const opts = (f: Fake) => ({
  run: f.run,
  org: 'harborlight-org',
  region: 'sjc',
  probeFile: '/tmp/wall.py',
  sleep: async () => {},
  log: () => {},
});

describe('the network wall check', () => {
  it('passes when every control connects and every cross-network probe is refused', async () => {
    const f = fakeFly();
    const r = await runNetworkWall(opts(f));
    expect(r.verdict).toEqual({ ok: true, reasons: [] });
    expect(r.rows).toHaveLength(PROBES.length);
    expect(r.rows.filter((x) => x.kind === 'wall').map((x) => x.outcome)).toEqual(
      Array(4).fill('timeout'),
    );
    // Each project app is on a network of its own; the peer shares Harborlight's.
    const creates = f.calls.filter((c) => c[0] === 'apps' && c[1] === 'create');
    expect(creates.map((c) => [c[2], c[c.indexOf('--network') + 1]])).toEqual([
      ['cw-walltest-harborlight', 'cw-walltest-harborlight'],
      ['cw-walltest-riverbend', 'cw-walltest-riverbend'],
      ['cw-walltest-harborlight-peer', 'cw-walltest-harborlight'],
    ]);
    // Both directions, by name and by address.
    const walls = f.calls.filter((c) => c[1] === 'exec').slice(4);
    expect(walls.map((c) => `${c[c.indexOf('--app') + 1]} ${(c[3] ?? '').split(' ')[3]}`)).toEqual([
      'cw-walltest-harborlight cw-walltest-riverbend.internal',
      'cw-walltest-harborlight fdaa:0:2::2',
      'cw-walltest-riverbend cw-walltest-harborlight.internal',
      'cw-walltest-riverbend fdaa:0:1::2',
    ]);
    expect(f.apps.size).toBe(0);
    expect(table(r.rows)).toContain('PASS');
  });

  it('fails when a probe crosses the wall', async () => {
    const f = fakeFly({
      answer: (from, to, same) =>
        same || (from === 'cw-walltest-riverbend' && to === 'cw-walltest-harborlight')
          ? 'connected'
          : 'timeout',
    });
    const r = await runNetworkWall(opts(f));
    expect(r.verdict.ok).toBe(false);
    expect(r.verdict.reasons).toEqual([
      'riverbend reached harborlight over .internal: connected',
      'riverbend reached harborlight over 6PN: connected',
    ]);
  });

  it('fails when the control cannot connect, even though every wall probe would read refused', async () => {
    // A probe that reaches nothing: every wall row would pass on its own.
    const f = fakeFly({ answer: () => 'timeout' });
    const r = await runNetworkWall({ ...opts(f), controlTries: 3 });
    expect(r.verdict.ok).toBe(false);
    expect(r.verdict.reasons[0]).toContain('control harborlight -> harborlight over .internal');
    expect(r.verdict.reasons[0]).toContain('no wall row can be trusted');
    // It stopped at the failed control, after its tries, and read no wall row.
    expect(r.rows.map((x) => x.kind)).toEqual(['control']);
    expect(f.calls.filter((c) => c[1] === 'exec')).toHaveLength(3);
    expect(f.apps.size).toBe(0);
  });

  it('fails a wall row whose probe never ran, rather than reading it as refused', async () => {
    const f = fakeFly({
      fail: (args) =>
        args[1] === 'exec' &&
        (args[3] ?? '').includes('riverbend.internal') &&
        args.includes('cw-walltest-harborlight'),
    });
    const r = await runNetworkWall(opts(f));
    expect(r.verdict.ok).toBe(false);
    expect(r.verdict.reasons).toEqual([
      'harborlight reached riverbend over .internal: probe-error',
    ]);
    expect(readOutcome(0, 'Connecting...\n')).toBe('probe-error');
    expect(readOutcome(0, 'result=EHOSTUNREACH\n')).toBe('EHOSTUNREACH');
  });

  it('destroys every app it made after a step fails mid-run', async () => {
    const f = fakeFly({
      fail: (args) =>
        args[0] === 'machine' && args[1] === 'run' && args.includes('cw-walltest-riverbend'),
    });
    const r = await runNetworkWall(opts(f));
    expect(r.verdict.ok).toBe(false);
    expect(r.error).toContain('fly machine run');
    const destroyed = f.calls.filter((c) => c[1] === 'destroy').map((c) => c[2]);
    expect(destroyed).toEqual(['cw-walltest-riverbend', 'cw-walltest-harborlight']);
    expect(f.apps.size).toBe(0);
    // The peer was never made, so it is not destroyed.
    expect(f.calls.some((c) => c[2] === 'cw-walltest-harborlight-peer')).toBe(false);
  });

  it('destroys an app whose create failed after Fly made it', async () => {
    const f = fakeFly();
    const base = f.run;
    const run: FlyRunner = (args) => {
      const r = base(args);
      // Fly made the app, then the command failed.
      return args[1] === 'create' && args[2] === 'cw-walltest-riverbend'
        ? { status: 1, stdout: '', stderr: 'fixture timeout' }
        : r;
    };
    const r = await runNetworkWall({ ...opts(f), run });
    expect(r.verdict.ok).toBe(false);
    expect(f.apps.size).toBe(0);
    expect(r.verdict.reasons).toEqual([
      'stopped: fly apps create cw-walltest-riverbend failed: fixture timeout',
      `only 0 of ${PROBES.length} probes ran`,
    ]);
  });

  it('does not report an app as left over when its destroy failed because it never existed', async () => {
    const f = fakeFly({
      fail: (args) => args[1] === 'create' && args[2] === 'cw-walltest-riverbend',
    });
    const base = f.run;
    const run: FlyRunner = (args) =>
      args[1] === 'destroy' && args[2] === 'cw-walltest-riverbend'
        ? { status: 1, stdout: '', stderr: 'no such app' }
        : base(args);
    const r = await runNetworkWall({ ...opts(f), run });
    expect(r.verdict.reasons.some((x) => x.includes('was not destroyed'))).toBe(false);
    expect(f.apps.size).toBe(0);
  });

  it('keeps destroying when one destroy fails, and names what was left', async () => {
    const f = fakeFly({
      fail: (args) => args[1] === 'destroy' && args[2] === 'cw-walltest-riverbend',
    });
    const r = await runNetworkWall(opts(f));
    expect(r.verdict.ok).toBe(false);
    expect(r.verdict.reasons).toEqual([
      'cw-walltest-riverbend was not destroyed: run fly apps destroy cw-walltest-riverbend --yes',
    ]);
    expect([...f.apps]).toEqual(['cw-walltest-riverbend']);
  });

  it('refuses to start over apps an earlier run left, and destroys none of them', async () => {
    const f = fakeFly({ existing: ['cw-walltest-riverbend'] });
    const r = await runNetworkWall(opts(f));
    expect(r.verdict.ok).toBe(false);
    expect(r.error).toContain('already exist: cw-walltest-riverbend');
    expect(f.calls.map((c) => c[1])).toEqual(['list']);
    expect([...f.apps]).toEqual(['cw-walltest-riverbend']);
  });

  it('a dry run prints every command and makes nothing', async () => {
    const lines: string[] = [];
    const r = await runNetworkWall({
      ...opts(fakeFly()),
      run: dryRunner((l) => lines.push(l)),
      controlTries: 1,
    });
    expect(lines[0]).toBe('fly apps list --json');
    expect(lines.filter((l) => l.startsWith('fly apps create'))).toHaveLength(3);
    expect(lines.filter((l) => l.startsWith('fly machine exec'))).toHaveLength(PROBES.length);
    expect(lines.filter((l) => l.startsWith('fly apps destroy'))).toHaveLength(3);
    expect(lines.some((l) => l.includes('--vm-size shared-cpu-1x --vm-memory 256'))).toBe(true);
    expect(r.rows.every((x) => x.outcome === 'not-run')).toBe(true);
  });

  it('the script under --dry-run reads no token and exits 0', () => {
    const script = join(import.meta.dir, '../../../infra/project-machine/network-wall.ts');
    const out = spawnSync(process.execPath, [script, '--dry-run'], {
      encoding: 'utf8',
      // A PATH with no fly and no security: any real call would fail.
      env: { PATH: '/nonexistent', HOME: process.env.HOME ?? '' },
    });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain('fly apps create cw-walltest-harborlight --org <org>');
    expect(out.stdout).toContain('DRY RUN: nothing was made');
  });
});
