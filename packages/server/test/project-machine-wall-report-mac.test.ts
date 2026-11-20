/**
 * The Mac's wall report reads no Cloudflare or Fly token from the Keychain:
 * `wall-report.ts` runs as a subprocess with `security`, `gh`, `fly` and
 * `terraform` replaced by stand-ins on its PATH that log every call. CI's
 * sealed read comes from the `gh` stand-in. The positive control runs
 * `mac-ops.ts keychainHas` under the same PATH and sees its call logged, so
 * an empty log means the report made no call, not that the stand-in missed
 * one.
 *
 * And `.github/workflows/wall-read.yml`, the workflow that makes the read:
 * main only, each secret on the step that reads with it, actions pinned.
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
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import { storeAppToken, writePrivate } from '../../../infra/handoff/mac-store.ts';
import { generateHandoffKeys } from '../../../infra/handoff/seal.ts';
import { artifactFor, readFly, sealWallRead } from '../../../infra/project-machine/wall-read.ts';

const REPO = join(import.meta.dir, '..', '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'cw-wall-mac-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ACCOUNT = 'f'.repeat(32);
const tunnel = (p: string, n: number) => ({
  account_id: ACCOUNT,
  id: `11111111-2222-4333-8444-55555555555${n}`,
  name: `cw-${p}`,
  origin: `${p}-origin.saltmarsh.test`,
  public_host: `${p}.saltmarsh.test`,
});
const OUTPUTS: TfOutputs = {
  access: {
    harborlight: { aud: 'aud-h', hosts: ['harborlight.saltmarsh.test'] },
    riverbend: { aud: 'aud-r', hosts: ['riverbend.saltmarsh.test'] },
  },
  accessTeamDomain: 'saltmarsh.cloudflareaccess.test',
  tunnels: { harborlight: tunnel('harborlight', 1), riverbend: tunnel('riverbend', 2) },
  routerRoutes: {},
};

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

function world(): Record<string, string> {
  const bin = join(tmp, 'bin');
  const fixtures = join(tmp, 'fixtures');
  mkdirSync(bin, { recursive: true });
  mkdirSync(fixtures, { recursive: true });
  const mac = generateHandoffKeys();
  const handoff = join(tmp, 'handoff');
  writePrivate(join(handoff, 'key'), mac.privateKey);
  const notAfter = Math.floor(Date.now() / 1000) + 14 * 86_400;
  for (const app of ['cw-harborlight', 'cw-riverbend'])
    storeAppToken(handoff, app, { token: `fm2_fixture_${app}`, notAfter });
  const now = Date.now();
  writeFileSync(
    join(fixtures, `${artifactFor('cloudflare')}.json`),
    JSON.stringify(
      sealWallRead(mac.publicKey, {
        part: 'cloudflare',
        readAt: now,
        outputs: OUTPUTS,
        ingress: {},
        access: null,
        plan: { status: 0, summary: 'No changes.\n' },
      }),
    ),
  );
  writeFileSync(
    join(fixtures, `${artifactFor('fly')}.json`),
    JSON.stringify(
      sealWallRead(
        mac.publicKey,
        readFly(
          [
            { Name: 'cw-harborlight', Network: 'cw-harborlight' },
            { Name: 'cw-riverbend', Network: 'cw-riverbend' },
          ],
          now,
        ),
      ),
    ),
  );
  const runs = JSON.stringify({
    workflow_runs: [
      {
        id: 77,
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
  // ssh fails, so each machine reads as not answering; the lists are empty.
  stub(bin, 'fly', 'case "$*" in *ssh*) exit 1 ;; *) echo "[]" ;; esac');
  stub(bin, 'security', 'exit 44');
  stub(bin, 'terraform', 'exit 1');
  return {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: tmp,
    CW_HANDOFF_DIR: handoff,
  };
}

describe('the Mac side of the wall report', () => {
  const env = world();

  it('the stand-in sees a Keychain call when one is made (the control)', () => {
    const r = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `import { keychainHas } from './infra/project-machine/mac-ops.ts'; keychainHas('cw-control-entry');`,
      ],
      { cwd: REPO, env },
    );
    expect(r.exitCode).toBe(0);
    expect(log('security')).toHaveLength(1);
    rmSync(join(tmp, 'security.log'));
  });

  it('reports from CI read with gh, and never runs security or terraform', () => {
    const r = Bun.spawnSync(
      [
        process.execPath,
        'infra/project-machine/wall-report.ts',
        '--projects',
        'harborlight,riverbend',
      ],
      { cwd: REPO, env },
    );
    const out = r.stdout.toString();
    expect(r.stderr.toString()).not.toContain('FAILED');
    expect(out).toMatch(/CI read of Cloudflare\s+run 77, 0h old\s+PASS/);
    expect(out).toMatch(/CI read of fly apps list\s+run 77, 0h old\s+PASS/);
    expect(out).toMatch(/harborlight\s+Fly network\s+cw-harborlight\s+PASS/);
    expect(out).toMatch(
      /riverbend\s+tunnel\s+cw-riverbend -> riverbend-origin.saltmarsh.test\s+PASS/,
    );
    // The machines did not answer, so the report fails, as it should.
    expect(r.exitCode).toBe(1);
    expect(log('gh')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^run download 77 .*--name wall-read-cloudflare/),
        expect.stringMatching(/^run download 77 .*--name wall-read-fly/),
      ]),
    );
    expect(log('security')).toEqual([]);
    expect(log('terraform')).toEqual([]);
    expect(log('fly').some((l) => l.startsWith('apps list'))).toBe(false);
  }, 60_000);
});

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: { name?: string };
}
interface Job {
  if?: string;
  environment?: string;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: Step[];
}
const wf = Bun.YAML.parse(
  readFileSync(join(REPO, '.github', 'workflows', 'wall-read.yml'), 'utf8'),
) as { permissions?: unknown; on: Record<string, unknown>; jobs: Record<string, Job> };

describe('wall-read.yml', () => {
  const secretsIn = (env?: Record<string, string>) =>
    [
      ...Object.values(env ?? {})
        .join(' ')
        .matchAll(/secrets\.([A-Z0-9_]+)/g),
    ].map((m) => m[1]);

  it('runs on a schedule and a dispatch, every job on main alone, with no permission at the top', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(wf.permissions).toEqual({});
    expect(Object.keys(wf.jobs).sort()).toEqual(['cloudflare', 'fly']);
    for (const job of Object.values(wf.jobs)) {
      expect(job.if).toBe("github.ref == 'refs/heads/main'");
      expect(job.permissions).toEqual({ contents: 'read' });
      expect(job.env).toBeUndefined();
    }
  });

  it('reads Cloudflare with the repository read-only token, and Fly in fly-org', () => {
    expect(wf.jobs.cloudflare?.environment).toBeUndefined();
    expect(wf.jobs.fly?.environment).toBe('fly-org');
  });

  it('hands each secret to the one step that reads with it, never in a script', () => {
    const holders = (job?: Job) =>
      (job?.steps ?? []).filter((s) => secretsIn(s.env).length > 0).map((s) => s.name);
    expect(holders(wf.jobs.cloudflare)).toEqual(['Read Cloudflare and seal it to the Mac']);
    expect(holders(wf.jobs.fly)).toEqual(['Read fly apps list and seal it to the Mac']);
    const fly = wf.jobs.fly?.steps?.find((s) => s.name?.startsWith('Read'));
    expect(secretsIn(fly?.env)).toEqual(['FLY_API_TOKEN']);
    for (const job of Object.values(wf.jobs))
      for (const s of job.steps ?? []) expect(s.run ?? '').not.toContain('secrets.');
  });

  it('uploads each part under the name the Mac downloads, and pins every action', () => {
    for (const [part, job] of Object.entries(wf.jobs)) {
      const upload = job.steps?.find((s) => s.uses?.startsWith('actions/upload-artifact'));
      expect(upload?.with?.name).toBe(artifactFor(part as 'cloudflare' | 'fly'));
      for (const s of job.steps ?? [])
        if (s.uses) expect(s.uses).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });
});
