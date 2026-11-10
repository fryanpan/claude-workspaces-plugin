/**
 * What the project machine's entrypoint does with the lead's network wall
 * (`lead-egress.ts`, `wall_network` in `entrypoint.sh`), and what it says in
 * the boot log, for each way applying or probing the wall can turn out.
 *
 * The real entrypoint runs on the stubs of `project-machine-harness.ts`; the
 * `bun` stub answers `lead-egress.ts apply` and `probe` as a file in the log
 * folder tells it to. The rules themselves are
 * `project-machine-lead-egress.test.ts`.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASH,
  type Rec,
  machineDir,
  machineEnv,
  readRecords,
  stubs,
} from './project-machine-harness.ts';
import { waitFor } from './wait-for.ts';

const entrypoint = join(machineDir, 'entrypoint.sh');
const scratch = mkdtempSync(join(tmpdir(), 'machine-wall-'));
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) if (c.pid && c.exitCode === null) process.kill(-c.pid, 'SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
});

interface Boot {
  apply?: string;
  probe?: [number, string];
  env?: Record<string, string>;
  lead?: boolean;
}

function boot(b: Boot) {
  const s = stubs(scratch, '0', ['mkdir', 'ln']);
  if (b.apply !== undefined) writeFileSync(join(s.log, '.egress-apply'), `${b.apply}\n`);
  if (b.probe) writeFileSync(join(s.log, '.egress-probe'), `${b.probe[0]}\n${b.probe[1]}\n`);
  const homes = join(s.root, 'home');
  mkdirSync(join(homes, 'lead'), { recursive: true });
  const proc = join(s.root, 'proc');
  mkdirSync(join(proc, 'self'), { recursive: true });
  writeFileSync(join(proc, 'self', 'status'), 'Uid:\t0\t0\t0\t0\n');
  const lead =
    b.lead === false
      ? {}
      : {
          CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-fixture-riverbend-wall',
          CW_LEAD_BOARD: 'w-riverbend',
          FLY_APP_NAME: 'cw-riverbend',
          CW_LEAD_TOKEN_ORG: 'riverbend',
        };
  const child = spawn(BASH as string, [entrypoint], {
    env: {
      ...machineEnv(s.bin, s.volume),
      CW_MACHINE_HOME_ROOT: homes,
      CW_MACHINE_PROC_ROOT: proc,
      CW_MACHINE_CGROUP_ROOT: join(s.root, 'no-cgroup'),
      ...lead,
      ...b.env,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const out: string[] = [];
  child.stdout?.on('data', (d: Buffer) => out.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => out.push(d.toString()));
  const text = () => out.join('');
  const recs = () => readRecords(s.log).recs;
  return { ...s, text, recs };
}

const egressCalls = (recs: Rec[], verb: string) =>
  recs.filter((r) => r.argv.startsWith('bun ') && r.argv.endsWith(`lead-egress.ts ${verb}`));
const claude = (recs: Rec[]) => recs.filter((r) => r.argv.startsWith('claude '));

describe.skipIf(BASH === null)("the lead's network wall at boot", () => {
  it('applies the wall as root, probes it as the lead, logs both, and then starts the lead', async () => {
    const m = boot({ probe: [0, 'refused 1.1.1.1:443; api.anthropic.com:443 connected'] });
    await waitFor(() => claude(m.recs()).length > 0, { timeout: 20_000, describe: 'the lead' });
    const recs = m.recs();
    const [applied] = egressCalls(recs, 'apply');
    const [probed] = egressCalls(recs, 'probe');
    expect(applied?.uid).toBe('root');
    expect(probed?.uid).toBe('lead');
    // Neither holds a secret: each gets PATH and its user's names, nothing of root's.
    const bashOwn = new Set(['PWD', 'SHLVL', '_', 'OLDPWD']);
    expect([...(applied?.env.keys() ?? [])].filter((k) => !bashOwn.has(k))).toEqual(['PATH']);
    expect(probed?.env.has('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false);
    expect(m.text()).toContain("the lead's network wall is in: allowed: stub");
    expect(m.text()).toContain(
      "the lead's network wall holds: refused 1.1.1.1:443; api.anthropic.com:443 connected",
    );
  }, 30_000);

  it('starts no lead when the rules cannot be loaded, says why, and keeps the server running', async () => {
    const m = boot({ apply: 'IPv4 rules could not be loaded (iptables-restore: no nf_tables)' });
    await waitFor(() => m.text().includes('no lead agent runs'), {
      timeout: 20_000,
      describe: 'the entrypoint to pass the lead by',
    });
    await waitFor(() => m.recs().some((r) => r.argv.includes('bin.ts')), {
      timeout: 20_000,
      describe: 'the server',
    });
    expect(m.text()).toContain(
      "the lead's network is NOT walled: IPv4 rules could not be loaded (iptables-restore: no nf_tables)",
    );
    expect(m.text()).toContain('no lead agent runs, because its network is not walled');
    expect(claude(m.recs())).toEqual([]);
    expect(egressCalls(m.recs(), 'probe')).toEqual([]);
  }, 30_000);

  it('starts no lead when the probe gets through the wall', async () => {
    const m = boot({ probe: [1, 'the wall let through: a public IPv4 address (1.1.1.1:443)'] });
    await waitFor(() => m.text().includes('no lead agent runs'), {
      timeout: 20_000,
      describe: 'the entrypoint to pass the lead by',
    });
    expect(m.text()).toContain(
      "the lead's network is NOT walled: the probe as the lead says: the wall let through: a public IPv4 address (1.1.1.1:443)",
    );
    expect(claude(m.recs())).toEqual([]);
  }, 30_000);

  it('starts the lead, and says the wall is unproven, when the allowed host does not answer either', async () => {
    const m = boot({
      probe: [3, 'refused everything, but api.anthropic.com:443 did not answer either'],
    });
    await waitFor(() => claude(m.recs()).length > 0, { timeout: 20_000, describe: 'the lead' });
    expect(m.text()).toContain("the lead's network wall is in but UNPROVEN: refused everything");
  }, 30_000);

  it('runs the lead without the wall only when CW_LEAD_EGRESS=open, and says so', async () => {
    const m = boot({ apply: 'never asked', env: { CW_LEAD_EGRESS: 'open' } });
    await waitFor(() => claude(m.recs()).length > 0, { timeout: 20_000, describe: 'the lead' });
    expect(m.text()).toContain(
      "the lead's network is NOT walled: CW_LEAD_EGRESS=open, so the lead and the dev server may connect anywhere",
    );
    expect(egressCalls(m.recs(), 'apply')).toEqual([]);
  }, 30_000);

  it('holds the dev server to the same wall: none runs when the wall cannot be applied', async () => {
    const m = boot({
      lead: false,
      apply: 'IPv6 rules could not be loaded (ip6tables-restore: no such table)',
      env: { CW_DEV_SERVER_CMD: 'bun run dev' },
    });
    await waitFor(() => m.text().includes('no dev server runs'), {
      timeout: 20_000,
      describe: 'the entrypoint to pass the dev server by',
    });
    expect(m.text()).toContain("the lead's network is NOT walled: IPv6 rules could not be loaded");
    expect(m.recs().filter((r) => r.uid === 'cwdev')).toEqual([]);
  }, 30_000);

  it('applies the wall once when both the lead and the dev server run', async () => {
    // POSITIVE CONTROL for the case above: with the wall in, the dev server runs.
    const m = boot({ env: { CW_DEV_SERVER_CMD: 'bun run dev' } });
    await waitFor(() => claude(m.recs()).length > 0 && m.recs().some((r) => r.uid === 'cwdev'), {
      timeout: 20_000,
      describe: 'the lead and the dev server',
    });
    expect(egressCalls(m.recs(), 'apply')).toHaveLength(1);
    expect(egressCalls(m.recs(), 'probe')).toHaveLength(1);
  }, 30_000);
});
