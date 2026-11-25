/**
 * "Every surface is live": a note from an agent holding several tasks, and
 * one from an agent holding none, reach a Home page that is already open,
 * with no reload. `agent-notes-live-browser-driver.ts` drives a real server
 * and headless Chromium; these cases read its JSON. The wiring-level twin,
 * on the fake server, is `agent-notes-live.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { AgentNotesLiveReading } from './agent-notes-live-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();
const DRIVER = join(import.meta.dirname, 'agent-notes-live-browser-driver.ts');

let r: AgentNotesLiveReading;

describe.skipIf(CHROME === null)('Not on a task, on an open Home page', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: 170_000 });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as AgentNotesLiveReading;
  }, 180_000);

  it('starts empty, then shows both agents with their reasons, on the same page', () => {
    expect(r.before).toEqual([]);
    const byAgent = Object.fromEntries(r.after.map((g) => [g.agent, g]));
    expect(byAgent.Harborlight?.state).toBe('held several tasks, so no one task took this');
    expect(byAgent.Harborlight?.notes).toEqual(['Both arms green; merged the index half.']);
    expect(byAgent.Riverbend?.state).toBe('held no task, so there was nothing to put this on');
    expect(byAgent.Riverbend?.notes).toEqual(['Parked on the retention call.']);
    // No reload: the marker set before the posts is still on the page.
    expect(r.samePage).toBe(true);
  }, 60_000);

  it('the page threw nothing', () => {
    expect(r.errors).toEqual([]);
  }, 60_000);
});
