/**
 * What an agent reads before moving a project: the status line's reading on
 * the machine, and the report that names each listed token. The token list and
 * the move are `project-machine-token-list.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requiredSecrets } from '../../../infra/project-machine/deploy-plan.ts';
import { foldUsage, parseUsageFile } from '../../../infra/project-machine/lead-usage.ts';
import {
  leadReadCommand,
  parseLeadRead,
  renderUsage,
  usageReport,
} from '../../../infra/project-machine/token-usage.ts';
import { runTokens } from '../../../infra/project-machine/tokens.ts';
import { machineDir } from './project-machine-harness.ts';
import {
  fs,
  FIRST,
  ORGS,
  SECOND,
  appDir,
  expectNoTokenShown,
  flyCalls,
  flySecrets,
  listed,
  tmp,
  useTokenStandIns,
} from './project-machine-token-harness.ts';

useTokenStandIns();

describe('the status line writes a reading', () => {
  const INPUT = {
    session_id: 'private-session-id',
    cwd: '/data/lead/work',
    transcript_path: '/home/lead/.claude/projects/x.jsonl',
    rate_limits: {
      five_hour: { used_percentage: 12.5, resets_at: 1_800_000_000 },
      seven_day: { used_percentage: 40, resets_at: 1_800_100_000 },
    },
  };
  const script = join(machineDir, 'lead-usage.ts');
  const run = (root: string, input: string) =>
    spawnSync(process.execPath, [script], {
      input,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CW_LEAD_ROOT: root, CW_LEAD_TOKEN_LABEL: 'first-account' },
    });

  it('keeps the numbers and the label and nothing else from what it was handed', () => {
    const root = mkdtempSync(join(tmp, 'usage-'));
    const r = run(root, JSON.stringify(INPUT));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('12');
    const raw = readFileSync(join(root, 'usage.json'), 'utf8');
    expect(raw).not.toContain('private-session-id');
    expect(raw).not.toContain('transcript');
    expect(raw.trim().split('\n')).toHaveLength(1);
    const f = parseUsageFile(raw);
    expect(f?.label).toBe('first-account');
    expect(f?.fiveHour).toEqual({ usedPercent: 12.5, resetsAt: 1_800_000_000 });
    expect(f?.sevenDay?.usedPercent).toBe(40);
  });

  it('records that it ran when no rate_limits came, keeping an earlier reading', () => {
    const root = mkdtempSync(join(tmp, 'usage-'));
    run(root, JSON.stringify({ session_id: 'x' }));
    const empty = parseUsageFile(readFileSync(join(root, 'usage.json'), 'utf8'));
    expect(empty?.seenAt).toBeGreaterThan(0);
    expect(empty?.fiveHour).toBeNull();
    run(root, JSON.stringify(INPUT));
    run(root, JSON.stringify({ session_id: 'x' }));
    const kept = parseUsageFile(readFileSync(join(root, 'usage.json'), 'utf8'));
    expect(kept?.fiveHour?.usedPercent).toBe(12.5);
  });

  it('an earlier reading of another token is not carried over', () => {
    const before = { label: 'old', seenAt: 1, readAt: 1, fiveHour: null, sevenDay: null };
    const next = foldUsage(
      { ...before, fiveHour: { usedPercent: 99, resetsAt: 5 } },
      {},
      'first-account',
      100,
    );
    expect(next.fiveHour).toBeNull();
    expect(next.label).toBe('first-account');
  });

  it('survives input that is not JSON, and refuses values that are not numbers', () => {
    const root = mkdtempSync(join(tmp, 'usage-'));
    expect(run(root, 'not json').status).toBe(0);
    const bad = { rate_limits: { five_hour: { used_percentage: '<b>', resets_at: 1 } } };
    run(root, JSON.stringify(bad));
    expect(parseUsageFile(readFileSync(join(root, 'usage.json'), 'utf8'))?.fiveHour).toBeNull();
  });
});

describe('the report', () => {
  const NOW = 1_800_000_000_000;
  const usageLine = (label: string, five: number, ageMs = 60_000) =>
    JSON.stringify({
      label,
      seenAt: NOW - ageMs,
      readAt: NOW - ageMs,
      fiveHour: { usedPercent: five, resetsAt: NOW / 1000 + 3600 },
      sevenDay: { usedPercent: 30, resetsAt: NOW / 1000 + 86_400 },
    });
  const lead = (label: string, usage: string) => `connecting\ncw-usage-start\n${label}\n${usage}\n`;

  it('reads as the lead, so a link in the lead’s folder reaches nothing of root’s', () => {
    const root = mkdtempSync(join(tmp, 'read-'));
    const secret = join(tmp, 'root-only');
    writeFileSync(secret, 'ROOT_SECRET=1');
    symlinkSync(secret, join(root, 'usage.json'));
    writeFileSync(join(root, 'token-label'), 'first-account\n');
    const stub = mkdtempSync(join(tmp, 'stub-'));
    writeFileSync(join(stub, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n');
    chmodSync(join(stub, 'timeout'), 0o755);
    writeFileSync(
      join(stub, 'setpriv'),
      `#!/bin/sh\necho "$*" > "${root}/setpriv"\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
    );
    chmodSync(join(stub, 'setpriv'), 0o755);
    const r = spawnSync('sh', ['-c', leadReadCommand(root, `${stub}:/usr/bin:/bin`)], {
      encoding: 'utf8',
    });
    expect(readFileSync(join(root, 'setpriv'), 'utf8')).toContain('--reuid=lead');
    // What a planted file holds never parses into a reading.
    expect(parseLeadRead(r.stdout).usage).toBeNull();
    expect(parseLeadRead(r.stdout).label).toBe('first-account');
  });

  it('gives each listed token its newest reading and the projects on it', () => {
    const lines = renderUsage(
      ['first-account', 'second-account'],
      [
        {
          project: 'harborlight',
          ...parseLeadRead(lead('first-account', usageLine('first-account', 12, 600_000))),
        },
        {
          project: 'riverbend',
          ...parseLeadRead(lead('first-account', usageLine('first-account', 20))),
        },
      ],
      NOW,
    ).join('\n');
    expect(lines).toContain('first-account');
    expect(lines).toContain('harborlight');
    expect(lines).toContain('riverbend');
    expect(lines).toContain('20%');
    expect(lines).not.toContain('12%');
    expect(lines).toMatch(/second-account.*no reading/);
  });

  it('says plainly why there is no reading, in each of the three cases', () => {
    const noFile = renderUsage(
      ['first-account'],
      [{ project: 'riverbend', ...parseLeadRead(lead('first-account', '')) }],
      NOW,
    ).join('\n');
    expect(noFile).toContain('status line has not run');
    const ran = JSON.stringify({
      label: 'first-account',
      seenAt: NOW - 1000,
      readAt: null,
      fiveHour: null,
      sevenDay: null,
    });
    const noLimits = renderUsage(
      ['first-account'],
      [{ project: 'riverbend', ...parseLeadRead(lead('first-account', ran)) }],
      NOW,
    ).join('\n');
    expect(noLimits).toContain('no rate_limits');
    const failed = renderUsage(
      ['first-account'],
      [{ project: 'riverbend', label: null, usage: null, error: 'could not read the machine' }],
      NOW,
    ).join('\n');
    expect(failed).toContain('riverbend');
    expect(failed).toContain('could not read');
    expect(noFile).toContain('unproven');
  });

  it('marks a window that has ended, and shows a project on its own sign-in', () => {
    const ended = JSON.stringify({
      label: '',
      seenAt: NOW - 90_000_000,
      readAt: NOW - 90_000_000,
      fiveHour: { usedPercent: 88, resetsAt: NOW / 1000 - 100 },
      sevenDay: { usedPercent: 30, resetsAt: NOW / 1000 + 100 },
    });
    const lines = renderUsage(
      [],
      [{ project: 'riverbend', ...parseLeadRead(lead('', ended)) }],
      NOW,
    ).join('\n');
    expect(lines).toContain('own sign-in');
    expect(lines).toContain('riverbend');
    expect(lines).toContain('ended');
  });

  it('refuses what a steered lead wrote: nothing but a label and numbers is printed', () => {
    const planted = JSON.stringify({
      label: 'first-account',
      seenAt: NOW,
      readAt: NOW,
      fiveHour: { usedPercent: `${SECOND}`, resetsAt: 1 },
      sevenDay: null,
    });
    const r = parseLeadRead(lead(`${SECOND}\u001b[2J`, planted));
    expect(r.label).toBeNull();
    expect(r.usage).toBeNull();
    const lines = renderUsage([], [{ project: 'riverbend', ...r }], NOW).join('\n');
    expect(lines).not.toContain(SECOND);
  });

  it('one lead’s bad numbers cost only its own reading', () => {
    const huge = JSON.stringify({
      label: 'first-account',
      seenAt: NOW,
      readAt: NOW,
      fiveHour: { usedPercent: 5, resetsAt: 1e300 },
      sevenDay: null,
    });
    expect(parseLeadRead(lead('first-account', huge)).usage).toBeNull();
    const lines = renderUsage(
      ['first-account', 'second-account'],
      [
        { project: 'harborlight', ...parseLeadRead(lead('first-account', huge)) },
        {
          project: 'riverbend',
          ...parseLeadRead(lead('second-account', usageLine('second-account', 9))),
        },
      ],
      NOW,
    ).join('\n');
    expect(lines).toContain('9%');
  });

  it('one lead cannot speak for a token its project does not run on', () => {
    const forged = parseLeadRead(lead('first-account', usageLine('second-account', 0)));
    const honest = parseLeadRead(lead('second-account', usageLine('second-account', 70)));
    const lines = renderUsage(
      ['first-account', 'second-account'],
      [
        { project: 'harborlight', ...forged },
        { project: 'riverbend', ...honest },
      ],
      NOW,
    ).join('\n');
    expect(lines).toContain('70%');
    expect(lines).not.toMatch(/second-account.* 0%/);
    // A just-moved project is not reported as the status line having run.
    expect(lines).toContain('first-account [harborlight]: no reading: the status line has not run');
  });

  it('ignores a reading dated in the future', () => {
    const future = parseLeadRead(lead('first-account', usageLine('first-account', 1, -86_400_000)));
    const lines = renderUsage(['first-account'], [{ project: 'riverbend', ...future }], NOW).join(
      '\n',
    );
    expect(lines).toContain('no reading');
  });

  it('says a machine’s label is unreadable, and does not call it an own sign-in', () => {
    const lines = renderUsage(
      ['first-account'],
      [{ project: 'riverbend', label: null, usage: null }],
      NOW,
    ).join('\n');
    expect(lines).toContain('unreadable');
    expect(lines).not.toContain('own sign-in');
  });

  it('skips an app with no lead, which costs no tap', () => {
    for (const org of ORGS) writeFileSync(join(appDir(org), 'ssh-out'), lead('', ''));
    flySecrets('harborlight', [...requiredSecrets('quick'), 'CW_LEAD_BOARD']);
    flySecrets('riverbend', requiredSecrets('quick'));
    expect(usageReport([]).map((r) => r.project)).toEqual(['harborlight']);
    expect(flyCalls()).not.toContain('ssh console --app cw-riverbend');
  });

  it('usageReport reads every cw- app, or only the projects named, and prints no token', async () => {
    listed(1, 'first-account', FIRST);
    for (const org of ORGS) {
      flySecrets(org, [...requiredSecrets('quick'), 'CW_LEAD_BOARD']);
      writeFileSync(
        join(appDir(org), 'ssh-out'),
        lead('first-account', usageLine('first-account', 7)),
      );
    }
    writeFileSync(join(appDir('riverbend'), 'ssh-fails'), '');
    const all = usageReport([]);
    expect(all.map((r) => r.project)).toEqual(['harborlight', 'riverbend']);
    expect(all[0]?.usage?.fiveHour?.usedPercent).toBe(7);
    expect(all[1]?.error).toContain('could not read');
    rmSync(join(fs, 'calls'));
    expect(usageReport(['harborlight']).map((r) => r.project)).toEqual(['harborlight']);
    expect(flyCalls()).not.toContain('cw-riverbend');
    expect(await runTokens(['usage', '--project', 'harborlight'])).toBe(0);
    expectNoTokenShown(FIRST);
  });
});
