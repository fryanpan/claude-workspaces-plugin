/**
 * `launchChrome` against a stand-in browser, so a stalled cold start can be
 * built on purpose rather than waited for on a loaded CI runner.
 *
 * The stand-in is a shell script that does the one thing `launchChrome` reads
 * from a real Chrome — it writes `<profile>/DevToolsActivePort` — or declines
 * to, for as many launches as the case asks. It `exec`s `sleep` either way, so
 * the process a kill lands on is the one that was spawned.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Browser, launchChrome, stopBrowser } from './headless-chrome.ts';

const dirs: string[] = [];
const spawned: Browser[] = [];

afterEach(async () => {
  for (const b of spawned.splice(0)) await stopBrowser(b.proc, b.profile);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake Chrome whose first `stalls` launches never announce a port. */
function fakeChrome(behaviour: { stalls: number } | { exitCode: number }): {
  bin: string;
  launches: () => number;
} {
  const dir = mkdtempSync(join(tmpdir(), 'cw-fake-chrome-'));
  dirs.push(dir);
  const counter = join(dir, 'launches');
  const bin = join(dir, 'chrome');
  const body =
    'exitCode' in behaviour
      ? `exit ${behaviour.exitCode}`
      : [
          `if [ "$n" -le ${behaviour.stalls} ]; then exec sleep 60; fi`,
          `printf '4242\\n/devtools/browser/fake\\n' > "$prof/DevToolsActivePort"`,
          'exec sleep 60',
        ].join('\n');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'for a in "$@"; do case "$a" in --user-data-dir=*) prof="${a#--user-data-dir=}";; esac; done',
      `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${counter}'`,
      body,
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    launches: () => (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0),
  };
}

const args = (profile: string) => [`--user-data-dir=${profile}`];
const PER_LAUNCH_MS = 400;

describe('launchChrome', () => {
  it('replaces a launch that never announces a port, and hands back the one that does', async () => {
    const chrome = fakeChrome({ stalls: 1 });
    const seen: Browser[] = [];
    const browser = await launchChrome(chrome.bin, args, PER_LAUNCH_MS, 'fakechrome', (b) => {
      seen.push(b);
      spawned.push(b);
    });
    expect(browser.port).toBe(4242);
    expect(chrome.launches()).toBe(2);
    // The caller's cleanup is told about BOTH, and follows the live one.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(browser);
    // The stalled one is gone, profile and process, before its replacement.
    const stalled = seen[0];
    if (!stalled) throw new Error('no first launch recorded');
    expect(existsSync(stalled.profile)).toBe(false);
    expect(stalled.proc.exitCode !== null || stalled.proc.signalCode !== null).toBe(true);
  }, 30_000);

  it('still fails, naming both launches, when every launch stalls', async () => {
    const chrome = fakeChrome({ stalls: 99 });
    const seen: Browser[] = [];
    await expect(
      launchChrome(chrome.bin, args, PER_LAUNCH_MS, 'fakechrome', (b) => {
        seen.push(b);
        spawned.push(b);
      }),
    ).rejects.toThrow(/CDP never came up within 400ms, on 2 launches/);
    expect(chrome.launches()).toBe(2);
    expect(seen).toHaveLength(2);
  }, 30_000);

  it('does not relaunch a Chrome that exited — that is a failure, not a stall', async () => {
    const chrome = fakeChrome({ exitCode: 3 });
    await expect(
      launchChrome(chrome.bin, args, 5_000, 'fakechrome', (b) => {
        spawned.push(b);
      }),
    ).rejects.toThrow(/Chrome exited with 3 before CDP came up/);
    expect(chrome.launches()).toBe(1);
  }, 30_000);
});
