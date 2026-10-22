/**
 * A project server's real boot (`createServerDeps`), run in a child process
 * whose environment the test writes, plus the two routes that tell a page
 * which features its profile turned off. Every key is a fake string.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEATURE_CREDENTIAL_ENV,
  FOREIGN_CREDENTIAL_ENV,
  ORG_KEY_ENV,
  featuresOff,
} from '../src/project-profile.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const probe = join(import.meta.dir, 'fixtures', 'project-boot-probe.ts');

interface Report {
  built: Record<string, boolean>;
  spokenSetups: number[];
  spokenHeld: string[];
  featuresOff: { transcription?: string; spoken?: string };
  trace: { path: string; slot: { name: string; role: string } | null }[];
  env: string[];
}

/** Every credential a project server must not hold, each set to a fake. */
const EVERY_OTHER_KEY = Object.fromEntries(
  [...FOREIGN_CREDENTIAL_ENV, ...Object.values(FEATURE_CREDENTIAL_ENV).flat()].map((n) => [
    n,
    `fake-${n.toLowerCase()}`,
  ]),
);

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function boot(env: Record<string, string>, opts: { ghLogin?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cw-project-home-'));
  homes.push(home);
  if (opts.ghLogin) {
    mkdirSync(join(home, '.config', 'gh'), { recursive: true });
    writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n  user: alice\n');
  }
  // A clean environment: nothing of this runner's leaks in, so the Mac's
  // Keychain overrides and this session's variables cannot answer for it.
  const child = spawnSync(process.execPath, ['run', probe], {
    env: { PATH: process.env.PATH ?? '', HOME: home, USER: 'cw', ...env },
    encoding: 'utf8',
  });
  expect(child.status, child.stderr).toBe(0);
  const lines = child.stdout.trim().split('\n');
  return { log: lines.slice(0, -1).join('\n'), report: JSON.parse(lines.at(-1) ?? '{}') as Report };
}

describe('a project server started without its org key', () => {
  const { log, report } = boot(
    { FLY_APP_NAME: 'cw-harborlight', CW_PROJECT_PROFILE: 'claude-only', ...EVERY_OTHER_KEY },
    { ghLogin: true },
  );

  it('refuses every model call and says why in its log', () => {
    expect(report.trace.length).toBeGreaterThan(0);
    expect(report.trace.filter((u) => u.slot !== null)).toEqual([]);
    for (const name of [
      'voiceComplete',
      'voiceFeedbackTidy',
      'reviewJudge',
      'answerCoverage',
      'effortEstimator',
      'titleNamer',
      'coachSummarizer',
    ]) {
      expect(report.built[name], name).toBe(false);
    }
    expect(log).toContain('with no org key: every Claude call is refused');
    expect(log).toContain(ORG_KEY_ENV);
  });

  it('holds no other org’s key and no gh credential, and names a gh login on disk', () => {
    for (const name of Object.keys(EVERY_OTHER_KEY)) expect(report.env).not.toContain(name);
    expect(log).toContain('removed from this server');
    expect(log).toContain('ERROR: a gh login is on disk');
    // Names only: no fake value reached the log.
    expect(log).not.toContain('fake-');
  });

  it('turns transcription, voice and Gemini off, keys or no keys', () => {
    expect(report.built.transcription).toBe(false);
    expect(report.built.meetingBot).toBe(false);
    expect(report.built.calendarBot).toBe(false);
    expect(report.spokenSetups).toEqual([]);
    expect(report.spokenHeld).toEqual([]);
    expect(report.featuresOff.transcription).toBeTruthy();
    expect(report.featuresOff.spoken).toBeTruthy();
  });
});

describe('a project server holding its org key', () => {
  const { report } = boot({
    FLY_APP_NAME: 'cw-riverbend',
    [ORG_KEY_ENV]: 'fake-org-key',
    ANTHROPIC_API_KEY: 'fake-generic',
  });

  it('spends that key on every path, and keeps it while dropping the rest', () => {
    expect(report.trace.length).toBeGreaterThan(0);
    for (const use of report.trace) expect(use.slot).toEqual({ name: ORG_KEY_ENV, role: 'org' });
    expect(report.built.reviewJudge).toBe(true);
    expect(report.env).toContain(ORG_KEY_ENV);
    expect(report.env).not.toContain('ANTHROPIC_API_KEY');
    expect(report.featuresOff).toEqual({});
  });
});

describe('the pages on a claude-only server', () => {
  let dataDir: string;
  let handle: ServerHandle;
  let base: string;
  let boardId: string;
  const off = featuresOff({ FLY_APP_NAME: 'cw-x', CW_PROJECT_PROFILE: 'claude-only' });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-project-pages-'));
    handle = createServer({ port: 0, dataDir, featuresOff: off });
    base = `http://127.0.0.1:${handle.port}`;
    const ws = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harborlight' }),
    });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('tells the Record button transcription is off', async () => {
    const body = await (await fetch(`${base}/api/meeting-engines`)).json();
    expect(body).toEqual({ engines: [], default: null, off: off.transcription });
  });

  it('tells the board mic spoken replies are off', async () => {
    const body = (await (await fetch(`${base}/workspaces/${boardId}/voice/timings`)).json()) as {
      setups: number[];
      off?: string;
    };
    expect(body.setups).toEqual([]);
    expect(body.off).toBe(off.spoken);
  });
});
