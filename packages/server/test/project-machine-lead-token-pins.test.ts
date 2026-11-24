/**
 * Wall-off review H2 (residual): which Claude sign-in each org uses is
 * written down. A listed token goes to a project only when `machines.json`
 * pins it there; orgs may share one (Bryan, 2026-11-24). The daily wall
 * report reads which sign-in each machine's lead is set to and whether
 * Remote Control is on.
 *
 * Pure functions over stand-in lists and machine facts: no Keychain, Fly or
 * machine is touched.
 */
import { describe, expect, it } from 'bun:test';
import { readFacts } from '../../../infra/project-machine/machine-facts.ts';
import { type Machine, parseMachines } from '../../../infra/project-machine/machines.ts';
import { type ListedToken, pinnedToken } from '../../../infra/project-machine/token-list.ts';
import { leadRows } from '../../../infra/project-machine/wall-lead-rows.ts';

const tok = (label: string): ListedToken => ({ label, token: `fixture-${label}`, added: '' });
const LIST = [tok('first-account'), tok('second-account')];
const m = (project: string, over: Partial<Machine> = {}): Machine => ({
  project,
  tunnel: 'named',
  ...over,
});
const list = (machines: unknown[]) => JSON.stringify({ machines });

describe('a listed token goes only where machines.json pins it', () => {
  it('takes the pinned label', () => {
    const pins = [m('harborlight', { leadToken: 'first-account' }), m('riverbend')];
    expect(pinnedToken(LIST, 'harborlight', pins)?.label).toBe('first-account');
  });

  it('refuses an unpinned project, naming the first label no project pins', () => {
    // Before the fix this took the first listed token, which Harborlight holds.
    const pins = [m('harborlight', { leadToken: 'first-account' }), m('riverbend')];
    expect(() => pinnedToken(LIST, 'riverbend', pins)).toThrow(
      '"leadToken": "second-account" on riverbend in machines.json',
    );
  });

  it('names the first listed when every token is pinned elsewhere, since orgs may share', () => {
    const pins = [
      m('harborlight', { leadToken: 'first-account' }),
      m('saltmarsh', { leadToken: 'second-account' }),
      m('riverbend'),
    ];
    expect(() => pinnedToken(LIST, 'riverbend', pins)).toThrow(
      '"leadToken": "first-account" on riverbend',
    );
  });

  it('leaves an empty list to the per-org browser approval', () => {
    expect(pinnedToken([], 'riverbend', [m('riverbend')])).toBeUndefined();
  });

  it('an empty list sets nothing for a pinned project either, so a CI deploy, which reads no Keychain, goes on', () => {
    const pins = [m('riverbend', { leadToken: 'second-account' })];
    expect(pinnedToken([], 'riverbend', pins)).toBeUndefined();
    expect(() => pinnedToken([], 'riverbend', pins, 'second-account')).toThrow(
      'no token labelled second-account',
    );
  });

  it('refuses --claude-token on an unpinned project, naming the pin to write', () => {
    const pins = [m('harborlight', { leadToken: 'first-account' }), m('riverbend')];
    expect(() => pinnedToken(LIST, 'riverbend', pins, 'first-account')).toThrow(
      '"leadToken": "first-account" on riverbend',
    );
  });

  it('refuses --claude-token naming a label other than the pin', () => {
    const pins = [m('riverbend', { leadToken: 'second-account' })];
    expect(() => pinnedToken(LIST, 'riverbend', pins, 'first-account')).toThrow(
      'machines.json pins second-account on riverbend, not first-account',
    );
    expect(pinnedToken(LIST, 'riverbend', pins, 'second-account')?.label).toBe('second-account');
  });

  it('refuses a pinned label that is not on the list', () => {
    expect(() => pinnedToken(LIST, 'riverbend', [m('riverbend', { leadToken: 'gone' })])).toThrow(
      'no token labelled gone is on the list',
    );
  });

  it('lets two projects pin one label: a shared token is allowed', () => {
    const both = [
      m('harborlight', { leadToken: 'first-account' }),
      m('riverbend', { leadToken: 'first-account' }),
    ];
    expect(pinnedToken(LIST, 'riverbend', both)?.label).toBe('first-account');
  });
});

describe('machines.json carries the pins', () => {
  it('parses leadToken and remoteControl, and one label on two projects', () => {
    const [h, r] = parseMachines(
      list([
        { project: 'harborlight', leadToken: 'first-account', remoteControl: true },
        { project: 'riverbend', leadToken: 'first-account' },
      ]),
    );
    expect(h).toMatchObject({ leadToken: 'first-account', remoteControl: true });
    expect(r?.leadToken).toBe('first-account');
  });

  it('refuses a bad label and a non-boolean flag', () => {
    expect(() => parseMachines(list([{ project: 'riverbend', leadToken: 'Bad Label' }]))).toThrow(
      'leadToken',
    );
    expect(() => parseMachines(list([{ project: 'riverbend', remoteControl: 'yes' }]))).toThrow(
      'remoteControl',
    );
  });

  it('the committed file parses', async () => {
    const { MACHINES_FILE } = await import('../../../infra/project-machine/machines.ts');
    const { readFileSync } = await import('node:fs');
    expect(() => parseMachines(readFileSync(MACHINES_FILE, 'utf8'))).not.toThrow();
  });
});

describe('the machine reports its lead', () => {
  const io = (procs: string[][], env: Record<string, string> = {}) => ({
    procs: () =>
      procs.map((cmdline, i) => ({
        pid: i + 2,
        ppid: 1,
        uid: 10004,
        cmdline,
        environ: () => ({}),
      })),
    read: () => null,
    leadEnv: () => env,
    dirs: () => [],
    publicKey: () => null,
  });
  const DIGEST = 'f'.repeat(64);

  it('reads the label from the marker the deploy set, never the digest', () => {
    const f = readFacts(
      io([['claude', '--remote-control', 'Riverbend lead']], {
        CW_LEAD_TOKEN_ORG: `listed:second-account:${DIGEST}`,
      }),
    );
    expect(f.lead).toEqual({ tokenLabel: 'second-account', remoteControl: true });
    expect(JSON.stringify(f)).not.toContain(DIGEST);
  });

  it("reads an org-name marker as the org's own approval, and no marker as none", () => {
    expect(readFacts(io([], { CW_LEAD_TOKEN_ORG: 'riverbend' })).lead?.tokenLabel).toBe('');
    expect(readFacts(io([['claude']])).lead).toEqual({ tokenLabel: null, remoteControl: false });
  });

  it('carries back only a label out of a malformed marker', () => {
    const f = readFacts(io([], { CW_LEAD_TOKEN_ORG: 'listed:Saltmarsh Secret:x' }));
    expect(f.lead?.tokenLabel).toBe('(not a label)');
  });

  it('sees Remote Control as a set secret or as --remote-control=<name>', () => {
    expect(readFacts(io([], { CW_LEAD_REMOTE_CONTROL: '1' })).lead?.remoteControl).toBe(true);
    expect(readFacts(io([['claude', '--remote-control=lead']])).lead?.remoteControl).toBe(true);
    expect(readFacts(io([['claude', '--remote-controlx']])).lead?.remoteControl).toBe(false);
  });
});

describe('the daily report judges each lead', () => {
  const lead = (tokenLabel: string | null, remoteControl = false) => ({
    tokenLabel,
    remoteControl,
  });
  const failing = (rows: Array<{ project: string; check: string; answer: string; ok: boolean }>) =>
    rows.filter((r) => !r.ok).map((r) => `${r.project} ${r.check}: ${r.answer}`);

  it('passes pinned, distinct sign-ins with Remote Control off', () => {
    const pins = [
      m('harborlight', { leadToken: 'first-account' }),
      m('riverbend', { leadToken: 'second-account' }),
    ];
    const rows = leadRows(
      pins,
      new Map([
        ['harborlight', lead('first-account')],
        ['riverbend', lead('second-account')],
      ]),
    );
    expect(failing(rows)).toEqual([]);
    expect(rows.length).toBe(4);
  });

  it('fails a lead on a label machines.json does not pin there, naming who shares it', () => {
    const pins = [m('harborlight', { leadToken: 'first-account' }), m('riverbend')];
    const rows = leadRows(
      pins,
      new Map([
        ['harborlight', lead('first-account')],
        ['riverbend', lead('first-account')],
      ]),
    );
    expect(failing(rows)).toEqual([
      'riverbend lead sign-in: first-account, which machines.json does not pin here; also run by harborlight',
    ]);
  });

  it('passes a shared sign-in both projects pin, and names who shares it', () => {
    const pins = ['harborlight', 'riverbend'].map((p) => m(p, { leadToken: 'first-account' }));
    const rows = leadRows(pins, new Map(pins.map((p) => [p.project, lead('first-account')])));
    expect(failing(rows)).toEqual([]);
    expect(rows.find((r) => r.project === 'riverbend')?.answer).toBe(
      'first-account, also run by harborlight',
    );
  });

  it('passes a lead on its own approval, and no lead at all', () => {
    const facts = new Map([
      ['harborlight', lead('')],
      ['riverbend', lead(null)],
    ]);
    expect(failing(leadRows([m('harborlight'), m('riverbend')], facts))).toEqual([]);
  });

  it('fails Remote Control on where machines.json does not allow it, and passes it where it does', () => {
    const facts = new Map([
      ['harborlight', lead('', true)],
      ['riverbend', lead('', true)],
    ]);
    const pins = [m('harborlight'), m('riverbend', { remoteControl: true })];
    expect(failing(leadRows(pins, facts))).toEqual([
      'harborlight Remote Control: on, and machines.json does not allow it',
    ]);
  });

  it('fails a machine whose probe does not report its lead', () => {
    expect(failing(leadRows([m('riverbend')], new Map([['riverbend', undefined]])))).toEqual([
      'riverbend lead sign-in: not reported: the machine runs an image older than this check',
      'riverbend Remote Control: not reported: the machine runs an image older than this check',
    ]);
  });
});
