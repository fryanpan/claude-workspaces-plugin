/**
 * The Mac's `machine:deploy` and `signin:callbacks` take prod's Terraform
 * outputs from the newest sealed wall read when no state credential is
 * configured (`mac-outputs.ts`), and from the state when one is.
 *
 * The subprocess cases run the real scripts with `security`, `gh`, `fly` and
 * `terraform` replaced by stand-ins on PATH that log every call. The control
 * runs the same deploy with a (fake) state credential in its environment and
 * sees the terraform stand-in called, so an empty terraform log on the
 * sealed path means no call was made, not that the stand-in missed one.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StateRefused, type TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import { stateDir } from '../../../infra/cloudflare/terraform.ts';
import { storeAppToken, writePrivate } from '../../../infra/handoff/mac-store.ts';
import { generateHandoffKeys } from '../../../infra/handoff/seal.ts';
import {
  type MacOutputsIo,
  macOutputs,
  stateCredentialConfigured,
} from '../../../infra/project-machine/mac-outputs.ts';
import { DISPATCH_HINT, MAX_AGE_MS } from '../../../infra/project-machine/wall-read-pull.ts';
import { artifactFor, sealWallRead } from '../../../infra/project-machine/wall-read.ts';

const REPO = join(import.meta.dir, '..', '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'cw-mac-outputs-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ACCOUNT = 'e'.repeat(32);
const TUNNEL_ID = '11111111-2222-4333-8444-555555555551';
const OUTPUTS: TfOutputs = {
  access: { harborlight: { aud: 'aud-h', hosts: ['harborlight.saltmarsh.test'] } },
  accessTeamDomain: 'saltmarsh.cloudflareaccess.test',
  tunnels: {
    harborlight: {
      account_id: ACCOUNT,
      id: TUNNEL_ID,
      name: 'cw-harborlight',
      origin: 'harborlight-origin.saltmarsh.test',
      public_host: 'harborlight.saltmarsh.test',
    },
  },
  routerRoutes: { harborlight: 'harborlight.riverbend.test/*' },
};

const read = (readAt: number) => ({
  part: 'cloudflare' as const,
  readAt,
  outputs: OUTPUTS,
  ingress: {},
  access: null,
  plan: { status: 0, summary: 'No changes.\n' },
});

describe('macOutputs', () => {
  const NOW = 1_800_000_000_000;
  const io = (over: Partial<MacOutputsIo> = {}): MacOutputsIo & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      sources: { env: {}, keychainHas: () => false, keychainRead: () => '' },
      state: (env) => {
        calls.push(`state ${env}`);
        return { access: {}, accessTeamDomain: null, tunnels: {}, routerRoutes: {} };
      },
      sealed: () => {
        calls.push('sealed');
        return { read: read(NOW - 3_600_000), runId: '42' };
      },
      now: () => NOW,
      say: () => {},
      ...over,
    };
  };

  it('reads the sealed read, all four outputs, when no credential is configured', () => {
    const i = io();
    expect(macOutputs('prod', i)).toEqual(OUTPUTS);
    expect(i.calls).toEqual(['sealed']);
  });

  it('reads the state when the environment holds the pair, or the Keychain an entry', () => {
    const env = io({
      sources: {
        env: { AWS_ACCESS_KEY_ID: 'id-alice', AWS_SECRET_ACCESS_KEY: 'secret-bob' },
        keychainHas: () => false,
        keychainRead: () => '',
      },
    });
    macOutputs('staging', env);
    expect(env.calls).toEqual(['state staging']);
    for (const entry of [
      'cloudflare-r2-tfstate',
      'r2-tfstate-access-key-id',
      'r2-tfstate-secret-access-key',
    ]) {
      const kc = io({
        sources: { env: {}, keychainHas: (n) => n === entry, keychainRead: () => '' },
      });
      macOutputs('prod', kc);
      expect(kc.calls).toEqual(['state prod']);
    }
  });

  it('half an env pair is not a credential', () => {
    expect(
      stateCredentialConfigured({
        env: { AWS_ACCESS_KEY_ID: 'id-alice', AWS_SECRET_ACCESS_KEY: ' ' },
        keychainHas: () => false,
        keychainRead: () => '',
      }),
    ).toBe(false);
  });

  it('refuses a read older than the limit, or from the future, naming the dispatch', () => {
    const old = io({ sealed: () => ({ read: read(NOW - MAX_AGE_MS - 60_000), runId: '41' }) });
    expect(() => macOutputs('prod', old)).toThrow(DISPATCH_HINT);
    const ahead = io({ sealed: () => ({ read: read(NOW + 3_600_000), runId: '43' }) });
    expect(() => macOutputs('prod', ahead)).toThrow(DISPATCH_HINT);
    // Just inside the limit still passes.
    const edge = io({ sealed: () => ({ read: read(NOW - MAX_AGE_MS), runId: '44' }) });
    expect(macOutputs('prod', edge)).toEqual(OUTPUTS);
  });

  it('falls back to the sealed read when the state refuses the credential', () => {
    const i = io({
      sources: {
        env: {},
        keychainHas: (n) => n === 'cloudflare-r2-tfstate',
        keychainRead: () => '',
      },
      state: (env) => {
        i.calls.push(`state ${env}`);
        throw new StateRefused(
          'terraform init for prod exited 1: the state bucket refused the credential',
        );
      },
    });
    const said: string[] = [];
    i.say = (l) => said.push(l);
    expect(macOutputs('prod', i)).toEqual(OUTPUTS);
    expect(i.calls).toEqual(['state prod', 'sealed']);
    expect(said).toEqual([
      "[outputs] the state was refused (terraform init for prod exited 1: the state bucket refused the credential): prod's Terraform outputs from the sealed wall read, run 42, 1h old",
    ]);
    // Staging has no sealed read, so its refusal stands.
    expect(() => macOutputs('staging', i)).toThrow('the state bucket refused the credential');
  });

  it('a state failure that is not a refusal stands: no sealed read is pulled', () => {
    const i = io({
      sources: {
        env: {},
        keychainHas: (n) => n === 'cloudflare-r2-tfstate',
        keychainRead: () => '',
      },
      state: (env) => {
        i.calls.push(`state ${env}`);
        throw new Error('terraform init for prod exited 1');
      },
    });
    expect(() => macOutputs('prod', i)).toThrow('terraform init for prod exited 1');
    expect(i.calls).toEqual(['state prod']);
  });

  it('refuses staging without a credential: the sealed read is prod only', () => {
    const i = io();
    expect(() => macOutputs('staging', i)).toThrow(/prod's outputs only/);
    expect(i.calls).toEqual([]);
  });
});

/** A shell stand-in that logs its arguments to `<name>.log` and then runs `body`. */
function stub(bin: string, name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\necho "$*" >> "${join(tmp, `${name}.log`)}"\n${body}\n`);
  chmodSync(p, 0o755);
}
const log = (name: string) => {
  const p = join(tmp, `${name}.log`);
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n') : [];
};
const clearLogs = () => {
  for (const n of ['gh', 'fly', 'security', 'terraform'])
    rmSync(join(tmp, `${n}.log`), { force: true });
};

/** A world whose newest wall-read run was made `ageMs` ago. */
function world(ageMs: number): Record<string, string> {
  const root = mkdtempSync(join(tmp, 'w-'));
  const bin = join(root, 'bin');
  const fixtures = join(root, 'fixtures');
  mkdirSync(bin, { recursive: true });
  mkdirSync(fixtures, { recursive: true });
  const mac = generateHandoffKeys();
  const handoff = join(root, 'handoff');
  writePrivate(join(handoff, 'key'), mac.privateKey);
  storeAppToken(handoff, 'cw-harborlight', {
    token: 'fm2_fixture_cw-harborlight',
    notAfter: Math.floor(Date.now() / 1000) + 14 * 86_400,
  });
  writeFileSync(
    join(fixtures, `${artifactFor('cloudflare')}.json`),
    JSON.stringify(sealWallRead(mac.publicKey, read(Date.now() - ageMs))),
  );
  const runs = JSON.stringify({
    workflow_runs: [
      {
        id: 88,
        created_at: '2026-11-19T04:41:00Z',
        event: 'schedule',
        head_branch: 'main',
        head_repository: { full_name: 'fryanpan/claude-workspaces-plugin' },
      },
    ],
  });
  stub(
    bin,
    'gh',
    `case "$*" in
  *wall-read.yml/runs*) echo '${runs}' ;;
  "run download"*)
    name=""; dir=""; prev=""
    for a in "$@"; do
      [ "$prev" = "--name" ] && name="$a"
      [ "$prev" = "--dir" ] && dir="$a"
      prev="$a"
    done
    cp "${fixtures}/$name.json" "$dir/$name.json" ;;
  *) echo '{}' ;;
esac`,
  );
  // The app reads as missing, so a dry run stops at "only fly-provision.yml
  // makes it", after the outputs were read.
  stub(bin, 'fly', 'echo "Could not find App" >&2; exit 1');
  stub(bin, 'security', 'exit 44');
  // As R2 answers a revoked key: init fails on a 401.
  stub(
    bin,
    'terraform',
    'echo "Error: Failed to get existing workspaces: operation error S3: ListObjectsV2, https response error StatusCode: 401, api error Unauthorized: Unauthorized" >&2; exit 1',
  );
  return {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    CW_HANDOFF_DIR: handoff,
  };
}

const deploy = (env: Record<string, string>) =>
  Bun.spawnSync(
    [
      process.execPath,
      'infra/project-machine/deploy.ts',
      '--project',
      'harborlight',
      '--tunnel',
      'named',
      '--dry-run',
    ],
    { cwd: REPO, env },
  );

describe('the Mac deploy and signin:callbacks with no state credential', () => {
  it('deploy finds the tunnel in the sealed read, and never runs terraform', () => {
    clearLogs();
    const r = deploy(world(3_600_000));
    const out = r.stdout.toString();
    const err = r.stderr.toString();
    expect(err).toContain('from the sealed wall read, run 88, 1h old');
    expect(out).toContain(`[deploy] tunnel cw-harborlight is ${TUNNEL_ID}, from Terraform`);
    expect(err).toContain('only fly-provision.yml makes');
    expect(log('gh')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^run download 88 .*--name wall-read-cloudflare/),
      ]),
    );
    expect(log('terraform')).toEqual([]);
  }, 60_000);

  it('deploy stops on a read older than 36h, naming the dispatch, before Fly', () => {
    clearLogs();
    const r = deploy(world(MAX_AGE_MS + 3_600_000));
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(DISPATCH_HINT);
    expect(log('terraform')).toEqual([]);
    expect(log('fly')).toEqual([]);
  }, 60_000);

  it('signin:callbacks lists the project from the sealed read', () => {
    clearLogs();
    const r = Bun.spawnSync([process.execPath, 'infra/project-machine/signin-callbacks.ts'], {
      cwd: REPO,
      env: world(3_600_000),
    });
    const out = r.stdout.toString();
    expect(r.exitCode).toBe(0);
    expect(out).toContain('(harborlight)');
    expect(out).not.toContain('could not read the Terraform outputs');
    expect(log('terraform')).toEqual([]);
  }, 60_000);

  /** Deploy with a (fake, revoked) state pair; the terraform stand-in exits 1 on init. */
  const withCredential = (ageMs: number) => {
    // readOutputs writes a backend file where none exists; remove only ours.
    const dir = stateDir('prod');
    const had = existsSync(dir);
    try {
      return deploy({
        ...world(ageMs),
        AWS_ACCESS_KEY_ID: 'id-alice',
        AWS_SECRET_ACCESS_KEY: 'secret-bob',
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      });
    } finally {
      if (!had) rmSync(dirname(dir), { recursive: true, force: true });
    }
  };

  it('a credential the state refuses falls back to the sealed read', () => {
    clearLogs();
    const r = withCredential(3_600_000);
    const err = r.stderr.toString();
    expect(log('terraform')).toEqual([expect.stringMatching(/^init /)]);
    expect(err).toContain(
      "the state was refused (terraform init for prod exited 1: the state bucket refused the credential): prod's Terraform outputs from the sealed wall read, run 88, 1h old",
    );
    expect(r.stdout.toString()).toContain(
      `[deploy] tunnel cw-harborlight is ${TUNNEL_ID}, from Terraform`,
    );
    expect(log('gh')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^run download 88 .*--name wall-read-cloudflare/),
      ]),
    );
  }, 60_000);

  it('with a credential, deploy runs terraform; refused and stale, it fails naming both (the control)', () => {
    clearLogs();
    const r = withCredential(MAX_AGE_MS + 3_600_000);
    const err = r.stderr.toString();
    expect(r.exitCode).toBe(1);
    expect(log('terraform')).toEqual([expect.stringMatching(/^init /)]);
    expect(err).toContain(
      'the state was refused (terraform init for prod exited 1: the state bucket refused the credential), and',
    );
    expect(err).toContain(DISPATCH_HINT);
    expect(log('fly')).toEqual([]);
  }, 60_000);
});
