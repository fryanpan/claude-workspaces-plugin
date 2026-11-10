/**
 * The lead's two limits on a real Linux kernel: the network wall
 * (`lead-egress.ts`) and the memory watchdog (`lead-memory.sh`), in a
 * container built from the project machine's own base image with the users
 * the Dockerfile makes. What the other tests cannot show: that the kernel
 * enforces the owner-matched rules, that a name off the list does not
 * resolve for the lead, that /proc reads the way the watchdog expects, and
 * that the kill lands.
 *
 * Opt-in, like the browser tests: it runs only with CW_CONTAINER_TESTS=1 and a
 * working `docker`, so `bun run verify` and CI skip it. It makes real
 * connections from the container: to api.anthropic.com:443 (allowed) and to
 * 1.1.1.1:443 (refused for the lead; root's connection there is the positive
 * control). The memory case allocates 96 MiB against a 48 MiB cap.
 *
 * Not shown here: a Fly machine's kernel. Whether it loads the rules and
 * whether it has a memory controller is the test machine's boot log
 * (docs/process/project-machine.md, "The lead's limits").
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { machineDir } from './project-machine-harness.ts';

const enabled =
  process.env.CW_CONTAINER_TESTS === '1' &&
  spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
if (!enabled)
  console.warn('[lead-limits-container] SKIPPED: set CW_CONTAINER_TESTS=1 with docker running');

const IMAGE = 'cw-lead-limits-test:local';
const DOCKERFILE = `FROM oven/bun:1.3.10-debian@sha256:367842b35abbdf23f39e23c71f3a08eee940ff2679a14e08a5afcf4a1436cd89
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates iptables \\
  && useradd --uid 10004 --create-home --shell /usr/sbin/nologin lead \\
  && useradd --uid 10005 --create-home --shell /usr/sbin/nologin cwdev
COPY lead-egress.ts lead-egress-plan.ts lead-egress.allow lead-memory.sh /app/infra/project-machine/
`;

/** Runs as root inside the container; each check prints one `name=value` line. */
const CHECK = join(import.meta.dir, 'fixtures', 'lead-limits-check.sh');

function parse(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) m.set(line.slice(0, i), line.slice(i + 1));
  }
  return m;
}

describe.skipIf(!enabled)("the lead's limits in a Linux container", () => {
  it('the wall refuses everything but the list, for the lead and the dev server, and the watchdog kills a lead past its cap', () => {
    const built = spawnSync('docker', ['build', '-q', '-t', IMAGE, '-f', '-', machineDir], {
      input: DOCKERFILE,
      encoding: 'utf8',
    });
    expect(built.status, built.stderr).toBe(0);
    const ran = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--cap-add',
        'NET_ADMIN',
        '--memory',
        '512m',
        IMAGE,
        'bash',
        '-c',
        readFileSync(CHECK, 'utf8'),
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    const r = parse(ran.stdout);
    console.log(ran.stdout);

    expect(r.get('apply')).toBe('0');
    expect(r.get('apply_line')).toMatch(
      /^allowed: api\.anthropic\.com tcp\/443 \(\d+ address(es)?\)/,
    );
    expect(r.get('probe')).toBe('0');
    expect(r.get('probe_line')).toContain('api.anthropic.com:443 connected');
    // POSITIVE CONTROL: root, outside the wall, reaches the address the lead cannot.
    expect(r.get('root_public')).toBe('connected');
    expect(r.get('lead_public')).toBe('refused');
    expect(r.get('cwdev_public')).toBe('refused');
    expect(r.get('lead_allowed')).toBe('connected');
    // GitHub is on the list for SSH only.
    expect(r.get('lead_github_https')).toBe('refused');
    expect(r.get('refresh')).toBe('0');
    expect(r.get('jumps')).toBe('2 jumps6=2');

    expect(r.get('oom')).toBe('1000');
    expect(r.get('oom_lowered')).toBe('no');
    // SIGKILL: 128 + 9.
    expect(r.get('grow_exit')).toBe('137');
    expect(r.get('grow_out')).not.toContain('survived');
    expect(r.get('watch_line')).toMatch(
      /the lead's processes hold \d+M, over their 48M cap: killing all \d+ of them/,
    );
    expect(r.get('lead_left')).toBe('0');
  }, 300_000);
});
