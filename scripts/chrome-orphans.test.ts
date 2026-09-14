/**
 * The two backstops for a launcher that never ran its own cleanup, against a
 * stand-in browser so they run on any machine with a `/bin/sh`.
 *
 * The stand-in writes `<profile>/DevToolsActivePort` and then loops rather
 * than `exec`ing `sleep`, so its command line keeps the `--headless` and
 * `--user-data-dir=` a real Chrome's has — which is what the reaper matches.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ORPHAN_REAP_AGE_MS,
  findOrphans,
  parseEtime,
  reapOrphanedChromes,
} from './chrome-orphans.ts';
import { profilePrefix, resolveRunId } from './ui-shot-lib.ts';

const HEADLESS_CHROME = resolve(process.cwd(), 'scripts/headless-chrome.ts');

const dirs: string[] = [];
const children: ChildProcess[] = [];
/** Stand-in browsers a case started, killed here if an assertion left one up. */
const browserPids: number[] = [];

afterEach(() => {
  for (const pid of browserPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(what: string, ok: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A temp dir this test owns, used as the TMPDIR its launches write profiles into. */
function ownDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cw-orphans-test-'));
  dirs.push(d);
  return d;
}

function fakeChrome(dir: string): string {
  const bin = join(dir, 'chrome');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'for a in "$@"; do case "$a" in --user-data-dir=*) prof="${a#--user-data-dir=}";; esac; done',
      `printf '4242\\n/devtools/browser/fake\\n' > "$prof/DevToolsActivePort"`,
      'while :; do sleep 1; done',
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe('parseEtime', () => {
  it.each([
    ['05:07', 307_000],
    ['1:02:03', 3_723_000],
    ['2-01:00:00', 176_400_000],
  ])('reads %s', (raw, ms) => {
    expect(parseEtime(raw)).toBe(ms);
  });

  it('refuses what is not an elapsed time', () => {
    expect(parseEtime('yesterday')).toBeNaN();
  });
});

describe('findOrphans', () => {
  const root = '/tmp/fixture-root';
  const chrome = (pid: number, ppid: number, etime: string, profile: string, headless = true) =>
    `${pid} ${ppid} ${etime} /opt/chrome ${headless ? '--headless=new ' : ''}--user-data-dir=${profile} about:blank`;
  const old = '15:00';

  it('names a headless cw-ui-shot Chrome under the root, parented to pid 1, past the age floor', () => {
    const listing = chrome(101, 1, old, `${root}/cw-ui-shot-pid9-abc123`);
    expect(findOrphans(listing, { root })).toEqual([
      { pid: 101, profile: `${root}/cw-ui-shot-pid9-abc123`, ageMs: 900_000 },
    ]);
  });

  it('leaves everything that fails any one condition', () => {
    const listing = [
      chrome(201, 4321, old, `${root}/cw-ui-shot-live-abc123`), // a live run's
      chrome(202, 1, '00:30', `${root}/cw-ui-shot-young-abc123`), // under the floor
      chrome(203, 1, old, `${root}/someone-elses-profile`), // not ours
      chrome(204, 1, old, '/elsewhere/cw-ui-shot-pid9-abc123'), // another root
      chrome(205, 1, old, `${root}/cw-ui-shot-pid9-abc123`, false), // not headless
      `206 1 ${old} /bin/sleep 600`,
    ].join('\n');
    expect(findOrphans(listing, { root })).toEqual([]);
  });

  it('holds the floor at ten minutes by default', () => {
    expect(ORPHAN_REAP_AGE_MS).toBe(600_000);
    const listing = chrome(301, 1, '09:59', `${root}/cw-ui-shot-pid9-abc123`);
    expect(findOrphans(listing, { root })).toEqual([]);
  });
});

describe('run labels', () => {
  it.each([undefined, '', 'undefined', 'null'])(
    'gives a missing run id (%s) the pid fallback',
    (raw) => {
      expect(profilePrefix(raw as string, 77)).toBe('cw-ui-shot-pid77-');
      expect(resolveRunId({ CW_UI_SHOT_RUN_ID: raw }, 77)).toBe('pid77');
    },
  );

  it('keeps a real label', () => {
    expect(profilePrefix('shots4', 77)).toBe('cw-ui-shot-shots4-');
  });
});

describe.skipIf(process.platform === 'win32')('a launcher that never cleans up', () => {
  /**
   * A bun process that launches the stand-in and then just waits, the way a
   * `ui:shot` sits in `--wait-for`. SIGKILL gives it no chance to run a
   * handler, so whatever removes the browser afterwards is not the launcher.
   */
  async function hostedLaunch(
    watchdog: boolean,
  ): Promise<{ host: ChildProcess; chromePid: number; profile: string }> {
    const dir = ownDir();
    const bin = fakeChrome(dir);
    const hostScript = join(dir, 'host.ts');
    writeFileSync(
      hostScript,
      [
        `import { launchChrome } from ${JSON.stringify(HEADLESS_CHROME)};`,
        `const b = await launchChrome(${JSON.stringify(bin)}, (p) => ['--headless=new', \`--user-data-dir=\${p}\`], 10_000, 'hosted');`,
        'console.log(JSON.stringify({ pid: b.proc.pid, profile: b.profile }));',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    const host = spawn('bun', [hostScript], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, TMPDIR: dir, CW_CHROME_WATCHDOG: watchdog ? '1' : '0' },
    });
    children.push(host);
    let out = '';
    host.stdout?.on('data', (d) => {
      out += String(d);
    });
    await waitFor('the host to report its browser', () => out.includes('\n'));
    const { pid, profile } = JSON.parse(out) as { pid: number; profile: string };
    browserPids.push(pid);
    return { host, chromePid: pid, profile };
  }

  it('a SIGKILLed launcher leaves no browser and no profile behind', async () => {
    const { host, chromePid, profile } = await hostedLaunch(true);
    // Positive control: the browser is up and its profile exists before the kill.
    expect(isAlive(chromePid)).toBe(true);
    expect(existsSync(profile)).toBe(true);

    host.kill('SIGKILL');
    await waitFor('the browser to die', () => !isAlive(chromePid));
    await waitFor('the profile to go', () => !existsSync(profile));
  }, 60_000);

  it('without the watchdog, the same kill leaves the browser running', async () => {
    // The control that makes the case above mean something: nothing else in
    // this setup would remove the browser.
    const { host, chromePid, profile } = await hostedLaunch(false);
    host.kill('SIGKILL');
    await waitFor('the host to die', () => host.signalCode !== null);
    // timed: two watchdog ticks — the watchdog polls its parent once a second.
    await new Promise((r) => setTimeout(r, 2500));
    expect(isAlive(chromePid)).toBe(true);
    expect(existsSync(profile)).toBe(true);
    process.kill(chromePid, 'SIGKILL');
    await waitFor('the control browser to die', () => !isAlive(chromePid));
  }, 60_000);

  it('the reaper kills an orphan and removes its profile', async () => {
    const dir = ownDir();
    const bin = fakeChrome(dir);
    const profile = mkdtempSync(join(dir, profilePrefix('reaped')));
    const orphan = spawn(bin, ['--headless=new', `--user-data-dir=${profile}`], {
      stdio: 'ignore',
    });
    children.push(orphan);
    await waitFor('the stand-in to start', () => existsSync(join(profile, 'DevToolsActivePort')));
    const pid = orphan.pid as number;
    // Reparenting to pid 1 is the OS's to do and differs across CI images, so
    // the listing is the one thing stood in for: the real process, as `ps`
    // would show it once its parent is gone and ten minutes have passed.
    const listing = `${pid} 1 10:00 /bin/sh ${bin} --headless=new --user-data-dir=${profile}`;
    const logged: string[] = [];
    const reaped = reapOrphanedChromes({
      root: dir,
      listProcesses: () => listing,
      log: (m) => logged.push(m),
    });

    expect(reaped.map((o) => o.pid)).toEqual([pid]);
    await waitFor(
      'the orphan to die',
      () => orphan.exitCode !== null || orphan.signalCode !== null,
    );
    expect(existsSync(profile)).toBe(false);
    expect(logged.join('\n')).toMatch(/cw-ui-shot-reaped-/);
  }, 60_000);
});
