/**
 * The deploy half of a seed board: `machines.json`'s `seedBoard` becomes
 * `machine:deploy --seed-board`, and that becomes the two settings the server
 * reads (`seed-board.ts`), the addresses from the Keychain alone. Stand-ins
 * for the Keychain and the outputs; nothing here runs a deploy.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import {
  type Observed,
  plan,
  projectConfig,
  requiredSecrets,
} from '../../../infra/project-machine/deploy-plan.ts';
import {
  MACHINES_FILE,
  deployArgs,
  parseMachines,
} from '../../../infra/project-machine/machines.ts';
import { SEED_MEMBERS_ENTRY, readSettings } from '../../../infra/project-machine/settings.ts';
import { parseSeedBoard } from '../src/seed-board.ts';

const list = (machines: unknown) => JSON.stringify({ machines });
const outputs = (): TfOutputs => ({ access: {}, accessTeamDomain: '', tunnels: {} });
const keychain = (entries: Record<string, string>) => ({
  keychainHas: (name: string) => name in entries,
  keychainRead: (name: string) => {
    const v = entries[name];
    if (v === undefined) throw new Error(`no ${name}`);
    return v;
  },
});

describe('a seed board in the machine list', () => {
  it('is on the two test servers and nowhere else', () => {
    const seeded = parseMachines(readFileSync(MACHINES_FILE, 'utf8'))
      .filter((m) => m.seedBoard !== undefined)
      .map((m) => m.project);
    expect(seeded).toEqual(['harborlight', 'riverbend']);
  });

  it('becomes --seed-board, and a bad name is refused before any deploy', () => {
    const [m] = parseMachines(list([{ project: 'riverbend', seedBoard: 'Sign-in check' }]));
    expect(deployArgs(m as never, 'abc123', false).slice(-2)).toEqual([
      '--seed-board',
      'Sign-in check',
    ]);
    for (const bad of ['', ' padded', 'line\nbreak', 7, 'x'.repeat(121)]) {
      expect(() => parseMachines(list([{ project: 'riverbend', seedBoard: bad }]))).toThrow(
        'seedBoard',
      );
    }
    expect(() =>
      projectConfig({ project: 'riverbend', imageLabel: '0'.repeat(40), seedBoard: '' }),
    ).toThrow('seed board');
  });
});

describe('the seed board settings machine:deploy derives', () => {
  it('names the board from machines.json and the addresses from the Keychain', () => {
    const found = readSettings(
      'riverbend',
      { outputs, ...keychain({ [SEED_MEMBERS_ENTRY]: 'alice@example.com\n' }) },
      { seedBoard: 'Sign-in check' },
    );
    const byName = new Map(found.settings.map((s) => [s.name, s]));
    expect(byName.get('CW_SEED_BOARD_MEMBERS')?.from).toBe(`Keychain ${SEED_MEMBERS_ENTRY}`);
    // What the deploy sets is what the server reads.
    expect(
      parseSeedBoard({
        CW_SEED_BOARD_NAME: byName.get('CW_SEED_BOARD_NAME')?.value(),
        CW_SEED_BOARD_MEMBERS: byName.get('CW_SEED_BOARD_MEMBERS')?.value(),
      }),
    ).toEqual({ name: 'Sign-in check', members: ['alice@example.com'] });
  });

  it('sets neither without the Keychain entry, and says why', () => {
    const found = readSettings('riverbend', { outputs, ...keychain({}) }, { seedBoard: 'X' });
    expect(found.settings.map((s) => s.name)).not.toContain('CW_SEED_BOARD_NAME');
    expect(found.skipped.join('\n')).toContain(`the Keychain has no ${SEED_MEMBERS_ENTRY}`);
  });

  it('CONTROL: a project with no seedBoard never reads the entry', () => {
    const asked: string[] = [];
    const src = keychain({ [SEED_MEMBERS_ENTRY]: 'alice@example.com' });
    const found = readSettings('moi', {
      outputs,
      keychainHas: (n) => {
        asked.push(n);
        return src.keychainHas(n);
      },
      keychainRead: src.keychainRead,
    });
    expect(found.settings.map((s) => s.name)).not.toContain('CW_SEED_BOARD_MEMBERS');
    expect(asked).not.toContain(SEED_MEMBERS_ENTRY);
  });
});

describe('the deploy plan for a seed board', () => {
  const SHA = 'a'.repeat(40);
  const observed = (extra: string[]): Observed => {
    const cfg = projectConfig({ project: 'riverbend', imageLabel: SHA });
    return {
      app: true,
      volumes: 1,
      keychain: new Set([cfg.keychain.identity, cfg.keychain.bucketAdmin, cfg.keychain.writer]),
      snapshots: true,
      lifecycle: false,
      secrets: new Set([...requiredSecrets('quick'), ...extra]),
      machines: [{ id: 'm1', state: 'started', imageTag: SHA, memoryMb: 512 }],
      browser: true,
    };
  };
  const SEEDED = ['CW_SEED_BOARD_NAME', 'CW_SEED_BOARD_MEMBERS'];

  it('unsets both settings once machines.json stops naming a seed board', () => {
    const cfg = projectConfig({ project: 'riverbend', imageLabel: SHA });
    expect(plan(cfg, observed(SEEDED))).toContainEqual({ kind: 'unset-secrets', names: SEEDED });
  });

  it('CONTROL: keeps them while it still names one, and unsets nothing never set', () => {
    const seeded = projectConfig({ project: 'riverbend', imageLabel: SHA, seedBoard: 'X' });
    const kinds = (a: { kind: string }[]) => a.map((x) => x.kind);
    expect(kinds(plan(seeded, observed(SEEDED)))).not.toContain('unset-secrets');
    const plain = projectConfig({ project: 'riverbend', imageLabel: SHA });
    expect(kinds(plan(plain, observed([])))).not.toContain('unset-secrets');
  });
});
