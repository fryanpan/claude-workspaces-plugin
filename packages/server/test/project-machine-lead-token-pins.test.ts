/**
 * Wall-off review H2 (residual): one Claude sign-in per org. A listed token
 * goes to a project only when `machines.json` pins it there, two projects
 * share one only when both say so, and the daily wall report reads which
 * sign-in each machine's lead runs on and whether Remote Control is on.
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

  it('refuses when every listed token is pinned on another project', () => {
    const pins = [
      m('harborlight', { leadToken: 'first-account' }),
      m('saltmarsh', { leadToken: 'second-account' }),
      m('riverbend'),
    ];
    expect(() => pinnedToken(LIST, 'riverbend', pins)).toThrow(
      'every listed token is pinned on another project',
    );
  });

  it('leaves an empty list to the per-org browser approval', () => {
    expect(pinnedToken([], 'riverbend', [m('riverbend')])).toBeUndefined();
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

  it('refuses a label two projects pin unless both share it on purpose', () => {
    const both = [
      m('harborlight', { leadToken: 'first-account' }),
      m('riverbend', { leadToken: 'first-account' }),
    ];
    expect(() => pinnedToken(LIST, 'riverbend', both)).toThrow('pinned on harborlight, riverbend');
    const shared = both.map((x) => ({ ...x, shareLeadToken: true }));
    expect(pinnedToken(LIST, 'riverbend', shared)?.label).toBe('first-account');
  });
});

describe('machines.json carries the pins', () => {
  it('parses leadToken, shareLeadToken and remoteControl', () => {
    const [h] = parseMachines(
      list([
        {
          project: 'harborlight',
          leadToken: 'first-account',
          shareLeadToken: true,
          remoteControl: true,
        },
      ]),
    );
    expect(h).toMatchObject({
      leadToken: 'first-account',
      shareLeadToken: true,
      remoteControl: true,
    });
  });

  it('refuses a bad label, a non-boolean flag and an unshared double pin', () => {
    expect(() => parseMachines(list([{ project: 'riverbend', leadToken: 'Bad Label' }]))).toThrow(
      'leadToken',
    );
    expect(() => parseMachines(list([{ project: 'riverbend', remoteControl: 'yes' }]))).toThrow(
      'remoteControl',
    );
    expect(() =>
      parseMachines(
        list([
          { project: 'harborlight', leadToken: 'first-account' },
          { project: 'riverbend', leadToken: 'first-account', shareLeadToken: true },
        ]),
      ),
    ).toThrow('first-account is pinned on harborlight, riverbend');
  });

  it('the committed file parses', async () => {
    const { MACHINES_FILE } = await import('../../../infra/project-machine/machines.ts');
    const { readFileSync } = await import('node:fs');
    expect(() => parseMachines(readFileSync(MACHINES_FILE, 'utf8'))).not.toThrow();
  });
});

describe('the machine reports its lead', () => {
  const io = (procs: string[][], label: string | null) => ({
    procs: () => procs.map((cmdline) => ({ cmdline, environ: () => ({}) })),
    read: () => null,
    readLeadFile: (p: string) => (p === '/data/lead/token-label' ? label : null),
    dirs: () => [],
    publicKey: () => null,
  });

  it('reads the token label and whether Remote Control is on', () => {
    const f = readFacts(io([['claude', '--remote-control', 'Riverbend lead']], 'second-account\n'));
    expect(f.lead).toEqual({ tokenLabel: 'second-account', remoteControl: true });
  });

  it('carries back only a label, never other text the lead put in the file', () => {
    expect(readFacts(io([], 'Saltmarsh secret value\n')).lead?.tokenLabel).toBe('(not a label)');
  });

  it('says no label and no Remote Control when neither is there', () => {
    expect(readFacts(io([['claude']], null)).lead).toEqual({
      tokenLabel: null,
      remoteControl: false,
    });
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

  it('fails two leads on one sign-in that machines.json does not share', () => {
    const pins = [m('harborlight', { leadToken: 'first-account' }), m('riverbend')];
    const rows = leadRows(
      pins,
      new Map([
        ['harborlight', lead('first-account')],
        ['riverbend', lead('first-account')],
      ]),
    );
    expect(failing(rows)).toEqual([
      'harborlight lead sign-in: first-account, also run by riverbend',
      'riverbend lead sign-in: first-account, which machines.json does not pin here; also run by harborlight',
    ]);
  });

  it('passes a shared sign-in both projects mark shareLeadToken', () => {
    const pins = ['harborlight', 'riverbend'].map((p) =>
      m(p, { leadToken: 'first-account', shareLeadToken: true }),
    );
    const facts = new Map(pins.map((p) => [p.project, lead('first-account')]));
    expect(failing(leadRows(pins, facts))).toEqual([]);
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
