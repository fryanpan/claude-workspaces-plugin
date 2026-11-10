/**
 * The lead's two limits on a real Linux kernel: the network wall
 * (`lead-egress.ts`) with its proxy (`lead-proxy.ts`), and the memory
 * watchdog (`lead-memory.sh`), in a container built from the project
 * machine's own base image with the users the Dockerfile makes. What the
 * other tests cannot show: that the kernel enforces the owner-matched rules,
 * that the lead's real tools (Bun's fetch, `bun install`, git over HTTPS,
 * ssh through its ProxyCommand) get out through the proxy and nowhere else,
 * that /proc reads the way the watchdog expects, and that the kill lands.
 *
 * Opt-in, like the browser tests: it runs only with CW_CONTAINER_TESTS=1 and a
 * working `docker`, so `bun run verify` and CI skip it. It makes real
 * connections from the container: to api.anthropic.com, registry.npmjs.org
 * and github.com (allowed, through the proxy), and to 1.1.1.1:443 and
 * example.com (refused for the lead; root's connection to 1.1.1.1 is the
 * positive control). The memory case allocates 96 MiB against a 48 MiB cap.
 *
 * Not shown here: a Fly machine's kernel. Whether it loads the rules and
 * whether it has a memory controller is the test machine's boot log
 * (docs/process/project-machine.md, "The lead's limits").
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { machineDir } from './project-machine-harness.ts';

const enabled =
  process.env.CW_CONTAINER_TESTS === '1' &&
  spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
if (!enabled)
  console.warn('[lead-limits-container] SKIPPED: set CW_CONTAINER_TESTS=1 with docker running');

const IMAGE = 'cw-lead-limits-test:local';
const DOCKERFILE = `FROM oven/bun:1.3.10-debian@sha256:367842b35abbdf23f39e23c71f3a08eee940ff2679a14e08a5afcf4a1436cd89
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git iptables openssh-client \\
  && useradd --uid 10004 --create-home --shell /usr/sbin/nologin lead \\
  && useradd --uid 10005 --create-home --shell /usr/sbin/nologin cwdev \\
  && useradd --uid 10007 --create-home --shell /usr/sbin/nologin cwproxy
COPY app /app
`;

/** The files the image needs, from the repo root: the machine's scripts and the proxy's address check. */
const repoRoot = join(machineDir, '..', '..');
const FILES = [
  'infra/project-machine/lead-egress.ts',
  'infra/project-machine/lead-egress-plan.ts',
  'infra/project-machine/lead-egress.allow',
  'infra/project-machine/lead-proxy.ts',
  'infra/project-machine/lead-proxy-plan.ts',
  'infra/project-machine/lead-memory.sh',
  'packages/server/src/outbound-fetch.ts',
];

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
  it('the wall lets the lead and the dev server out only through the proxy, to the list, and the watchdog kills a lead past its cap', () => {
    const context = mkdtempSync(join(tmpdir(), 'lead-limits-'));
    try {
      for (const f of FILES) {
        mkdirSync(dirname(join(context, 'app', f)), { recursive: true });
        copyFileSync(join(repoRoot, f), join(context, 'app', f));
      }
      writeFileSync(join(context, 'Dockerfile'), DOCKERFILE);
      const built = spawnSync('docker', ['build', '-q', '-t', IMAGE, context], {
        encoding: 'utf8',
      });
      expect(built.status, built.stderr).toBe(0);
    } finally {
      rmSync(context, { recursive: true, force: true });
    }
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
    expect(r.get('apply_line')).toMatch(/^uids 10004, 10005 reach loopback only/);
    expect(r.get('probe')).toBe('0');
    expect(r.get('probe_line')).toContain('https://api.anthropic.com through the proxy answered');
    // POSITIVE CONTROL: root, outside the wall, reaches the address the lead cannot.
    expect(r.get('root_public')).toBe('connected');
    expect(r.get('lead_public')).toBe('refused');
    expect(r.get('cwdev_public')).toBe('refused');
    expect(r.get('proxy_public')).toBe('connected');
    // The lead's tools, given only the proxy's address in their environment.
    expect(r.get('lead_fetch_npm')).toBe('200');
    // Bun hands back the proxy's own 403 as the response; proxy_log below says it was the proxy.
    expect(r.get('lead_fetch_unlisted')).toBe('403');
    expect(r.get('lead_bun_install')).toBe('0');
    expect(r.get('lead_git_https')).toBe('0');
    expect(r.get('lead_ssh_proxied')).toContain('Permission denied (publickey)');
    // ssh does not read HTTPS_PROXY: without its ProxyCommand it reaches nothing.
    expect(r.get('lead_ssh_direct')).not.toContain('Permission denied (publickey)');
    expect(r.get('proxy_log')).toContain('refused example.com:443: it is not on lead-egress.allow');
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
