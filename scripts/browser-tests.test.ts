/**
 * The browser gate: does the default hold, and does CI still opt in?
 *
 * The case that matters most is the CONTROL below. A partition that held
 * every member would pass an "is it held?" assertion just as happily as the
 * right one, so each holding case is paired with the same call at the other
 * setting. Same for the environment: the falsy table exists because "not
 * empty" and "is one of the yes words" behave identically on `1` and differ
 * on `0`, which is the spelling somebody actually reaches for to turn this
 * off.
 *
 * audit: no-text — the ci.yml case reads a workflow file, which is the
 * configuration under test, not a source file being grepped for behaviour.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BROWSER_TESTS_ENV,
  browserTestsEnabled,
  chromeForSuite,
  resetBrowserTestsNotice,
} from './browser-tests.ts';
import { CI_WORKFLOW, MEMBERS, partitionBrowserMembers } from './verify.ts';

describe('who has opted in', () => {
  it('nobody, when the variable is unset — that is the whole point', () => {
    expect(browserTestsEnabled({})).toBe(false);
  });

  it.each(['1', 'true', 'on', 'yes', 'TRUE', '  1  '])('%s means yes', (v) => {
    expect(browserTestsEnabled({ [BROWSER_TESTS_ENV]: v })).toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', '', '   ', 'maybe', '2'])('%s means no', (v) => {
    expect(browserTestsEnabled({ [BROWSER_TESTS_ENV]: v })).toBe(false);
  });
});

describe('the browser a suite may launch', () => {
  beforeEach(() => resetBrowserTestsNotice());

  it('is null with nobody opted in, and says so once rather than silently', () => {
    const said: string[] = [];
    const opts = { log: (m: string) => said.push(m), resolve: () => '/chrome' };
    expect(chromeForSuite({}, opts)).toBeNull();
    expect(chromeForSuite({}, opts)).toBeNull();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(BROWSER_TESTS_ENV);
  });

  it('CONTROL: the same resolver, opted in, hands back the binary and says nothing', () => {
    const said: string[] = [];
    const bin = chromeForSuite(
      { [BROWSER_TESTS_ENV]: '1' },
      { log: (m: string) => said.push(m), resolve: () => '/chrome' },
    );
    expect(bin).toBe('/chrome');
    expect(said).toEqual([]);
  });

  it('is null when opted in but nothing resolves, rather than throwing at load', () => {
    const bin = chromeForSuite(
      { [BROWSER_TESTS_ENV]: '1' },
      {
        resolve: () => {
          throw new Error('Chrome binary not found');
        },
      },
    );
    expect(bin).toBeNull();
  });
});

describe('what a local verify run holds back', () => {
  const browserIds = MEMBERS.filter((m) => m.browser === true).map((m) => m.id);

  it('holds every browser member and runs the rest', () => {
    const { run, held } = partitionBrowserMembers(MEMBERS, false);
    expect(held.map((m) => m.id)).toEqual(browserIds);
    expect(held.length).toBeGreaterThan(0);
    expect(run).toHaveLength(MEMBERS.length - held.length);
    expect(run.some((m) => m.browser)).toBe(false);
  });

  it('CONTROL: opted in, the same list runs whole and nothing is held', () => {
    const { run, held } = partitionBrowserMembers(MEMBERS, true);
    expect(held).toEqual([]);
    expect(run).toEqual(MEMBERS);
  });

  it('keeps test:vitest in the run — its browser cases skip themselves', () => {
    const { run } = partitionBrowserMembers(MEMBERS, false);
    expect(run.map((m) => m.id)).toContain('test:vitest');
  });
});

/**
 * The half a marker cannot enforce on its own: CI has to still opt in, or
 * this change would have quietly deleted the browser coverage everywhere
 * rather than only on a developer's machine.
 */
describe('ci.yml still opts in', () => {
  const yaml = readFileSync(CI_WORKFLOW, 'utf8');

  it('sets the variable on one step per gate that needs a browser', () => {
    const opted = yaml.split('\n').filter((l) => l.includes(`${BROWSER_TESTS_ENV}:`));
    // The browser members, plus test:vitest for the cases inside the suite.
    expect(opted).toHaveLength(MEMBERS.filter((m) => m.browser === true).length + 1);
    for (const l of opted) expect(l).toMatch(/'1'|"1"|:\s*1\s*$/);
  });

  it('names each browser member in a step that sets it', () => {
    for (const m of MEMBERS.filter((x) => x.browser === true)) {
      const at = yaml.indexOf(`bun run ${m.ci}`);
      expect(at, `${m.ci} is not run by ci.yml`).toBeGreaterThan(-1);
      // The env block sits above the `run:` line of the same step.
      expect(yaml.slice(Math.max(0, at - 400), at)).toContain(BROWSER_TESTS_ENV);
    }
  });
});
