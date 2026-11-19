/**
 * The handoff (infra/handoff/): CI seals a credential to one holder, the Mac
 * pulls and stores it. A sealed envelope opens only with its own key, a
 * tampered one does not open, every item is checked before it is stored, and
 * nothing a test hands over is ever printed. A fake `gh`; no network, no
 * Keychain.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type HandoffItem,
  HandoffSink,
  checkItem,
  macSinkFromEnv,
  openItems,
  recipientKey,
  sealItems,
} from '../../../infra/handoff/items.ts';
import { type KeygenIo, keygen } from '../../../infra/handoff/keygen.ts';
import {
  HANDOFF_REPO,
  readAppToken,
  readSeen,
  storeAppToken,
  writeSeen,
} from '../../../infra/handoff/mac-store.ts';
import {
  HANDOFF_FILE,
  MAC_ARTIFACT,
  type PullIo,
  WORKFLOWS,
  pull,
} from '../../../infra/handoff/pull.ts';
import { generateHandoffKeys, open, seal } from '../../../infra/handoff/seal.ts';

const SECRET = 'fixture-secret-Riverbend-0123456789';
const NOW_S = Math.floor(Date.UTC(2026, 10, 18) / 1000);

describe('seal', () => {
  it('opens with the key it was sealed to, and with no other', () => {
    const mac = generateHandoffKeys();
    const other = generateHandoffKeys();
    const env = seal(mac.publicKey, SECRET);
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(open(mac.privateKey, env)).toBe(SECRET);
    expect(() => open(other.privateKey, env)).toThrow('does not open');
  });

  it('refuses a tampered envelope', () => {
    const mac = generateHandoffKeys();
    const env = seal(mac.publicKey, SECRET);
    const ct = Buffer.from(env.ct, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 1;
    expect(() => open(mac.privateKey, { ...env, ct: ct.toString('base64') })).toThrow();
  });

  it('two seals of one value differ', () => {
    const mac = generateHandoffKeys();
    expect(seal(mac.publicKey, SECRET).ct).not.toBe(seal(mac.publicKey, SECRET).ct);
  });
});

describe('items', () => {
  it('checks every kind and refuses a bad target without naming the value', () => {
    expect(
      checkItem({ kind: 'keychain', name: 'cw-harborlight-backup-identity', value: SECRET }).kind,
    ).toBe('keychain');
    expect(() => checkItem({ kind: 'keychain', name: 'Bad Name', value: SECRET })).toThrow(
      'Keychain name',
    );
    expect(() =>
      checkItem({ kind: 'fly-app-token', app: 'harborlight', token: SECRET, notAfter: 1 }),
    ).toThrow('cw- app');
    let message = '';
    try {
      checkItem({
        kind: 'fly-secrets',
        app: 'cw-riverbend',
        secrets: { TUNNEL: `${SECRET}\nX=1` },
      });
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain('one line');
    expect(message).not.toContain(SECRET);
    expect(() => checkItem({ kind: 'shell', command: 'x' })).toThrow('unknown');
  });

  it('a sink writes nothing when empty, and seals what it gathered', () => {
    const mac = generateHandoffKeys();
    const writes: string[] = [];
    const sink = new HandoffSink('mac', '/out/handoff.json');
    expect(sink.flush(mac.publicKey, (_p, s) => writes.push(s))).toBe(false);
    sink.add({ kind: 'keychain', name: 'cw-saltmarsh-bucket-admin', value: SECRET });
    expect(sink.describe()).toEqual(['Keychain entry cw-saltmarsh-bucket-admin']);
    expect(sink.flush(mac.publicKey, (_p, s) => writes.push(s))).toBe(true);
    expect(writes[0]).not.toContain(SECRET);
    const opened = openItems(mac.privateKey, writes[0] ?? '');
    expect(opened.recipient).toBe('mac');
    expect(opened.items).toEqual([
      { kind: 'keychain', name: 'cw-saltmarsh-bucket-admin', value: SECRET },
    ]);
  });

  it('a sink exists only when CW_HANDOFF_OUT names a file', () => {
    expect(macSinkFromEnv({})).toBeNull();
    expect(macSinkFromEnv({ CW_HANDOFF_OUT: '/tmp/x.json' })?.outPath).toBe('/tmp/x.json');
  });

  it('a holder with no committed key is named, with the command that makes one', () => {
    expect(() => recipientKey('mac', () => '{"mac":"","fly-org":""}')).toThrow(
      'bun run handoff:keygen mac',
    );
    expect(recipientKey('fly-org', () => '{"fly-org":"abc"}')).toBe('abc');
  });
});

describe('mac store', () => {
  it('keeps the longer-lived app token, mode 600, and treats one near its end as none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-store-'));
    expect(storeAppToken(dir, 'cw-harborlight', { token: 'a', notAfter: NOW_S + 86_400 })).toBe(
      true,
    );
    expect(storeAppToken(dir, 'cw-harborlight', { token: 'b', notAfter: NOW_S + 3_600 })).toBe(
      false,
    );
    const file = join(dir, 'fly-tokens', 'cw-harborlight.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'fly-tokens')).mode & 0o777).toBe(0o700);
    expect(readAppToken(dir, 'cw-harborlight', NOW_S * 1000)).toBe('a');
    expect(readAppToken(dir, 'cw-harborlight', (NOW_S + 86_000) * 1000)).toBeNull();
    expect(readAppToken(dir, 'cw-riverbend', NOW_S * 1000)).toBeNull();
    expect(() => readAppToken(dir, '../etc', NOW_S * 1000)).toThrow('not a project app');
  });

  it('remembers pulled runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-seen-'));
    writeSeen(dir, new Set(['1', '2']));
    expect([...readSeen(dir)]).toEqual(['1', '2']);
  });
});

interface FakeRun {
  id: number;
  at: string;
  workflow: string;
  /** The sealed file, or null for a run with no artifact. */
  file: string | null;
  /** A second sealed file in the same artifact, as tokens.json. */
  tokens?: string;
  /** What started the run; workflow_dispatch when unset. */
  event?: string;
  /** The repository the run's head came from; this one when unset. */
  repo?: string;
}

/** The workflow a `gh api` list call names in its path. */
function workflowOf(args: string[]): string {
  return args.find((a) => a.includes('/workflows/'))?.match(/workflows\/([^/]+)\/runs/)?.[1] ?? '';
}

function pullWorld(runs: FakeRun[], key: string, seen = new Set<string>()) {
  const files = new Map<string, string>();
  const stored: HandoffItem[] = [];
  const said: string[] = [];
  let saved: Set<string> | null = null;
  let n = 0;
  const io: PullIo = {
    gh: (args) => {
      if (args[0] === 'api') {
        const rows = runs
          .filter((r) => r.workflow === workflowOf(args))
          .map((r) => ({
            id: r.id,
            created_at: r.at,
            event: r.event ?? 'workflow_dispatch',
            head_branch: 'main',
            head_repository: { full_name: r.repo ?? HANDOFF_REPO },
          }));
        return { status: 0, stdout: JSON.stringify({ workflow_runs: rows }), stderr: '' };
      }
      expect(args.slice(0, 2)).toEqual(['run', 'download']);
      expect(args[args.indexOf('--name') + 1]).toBe(MAC_ARTIFACT);
      const run = runs.find((r) => String(r.id) === args[2]);
      if (!run?.file)
        return { status: 1, stdout: '', stderr: 'no valid artifacts found to download' };
      const dir = args[args.indexOf('--dir') + 1] ?? '';
      files.set(join(dir, HANDOFF_FILE), run.file);
      if (run.tokens !== undefined) files.set(join(dir, 'tokens.json'), run.tokens);
      return { status: 0, stdout: '', stderr: '' };
    },
    privateKey: () => key,
    seen: () => seen,
    saveSeen: (s) => {
      saved = new Set(s);
    },
    tempDir: () => `/fake/${++n}`,
    readFile: (p) => {
      const f = files.get(p);
      if (f === undefined) throw new Error(`no file ${p}`);
      return f;
    },
    listFiles: (d) =>
      [...files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)),
    remove: () => {},
    store: (item) => {
      stored.push(item);
      return 'stored';
    },
    err: (s) => said.push(s),
  };
  return { io, stored, said, saved: () => saved };
}

describe('handoff:pull', () => {
  it('stores each new run oldest first, marks it pulled, and prints no value', () => {
    const mac = generateHandoffKeys();
    const sealed = (items: HandoffItem[]) => JSON.stringify(sealItems('mac', mac.publicKey, items));
    const runs: FakeRun[] = [
      {
        id: 20,
        at: '2026-11-18T10:00:00Z',
        workflow: 'cf-rotate-token.yml',
        file: sealed([
          {
            kind: 'service-token',
            name: 'agent riverbend',
            clientId: 'id.access',
            secret: SECRET,
            replace: true,
          },
        ]),
      },
      {
        id: 10,
        at: '2026-11-17T10:00:00Z',
        workflow: 'cloudflare.yml',
        file: sealed([
          {
            kind: 'service-token',
            name: 'agent riverbend',
            clientId: 'id.access',
            secret: 'old',
            replace: false,
          },
        ]),
      },
      { id: 30, at: '2026-11-18T11:00:00Z', workflow: 'fly-ci-tokens.yml', file: null },
    ];
    const w = pullWorld(runs, mac.privateKey);
    expect(pull(w.io)).toBe(0);
    expect(w.stored.map((i) => (i.kind === 'service-token' ? i.replace : null))).toEqual([
      false,
      true,
    ]);
    expect([...(w.saved() ?? [])].sort()).toEqual(['10', '20', '30']);
    expect(w.said.join('')).not.toContain(SECRET);
    expect(w.said.join('')).toContain('service token "agent riverbend" (rotated) stored');
  });

  it('reads every sealed file a run left, so a provisioning run hands over its keys and its token', () => {
    const mac = generateHandoffKeys();
    const sealed = (items: HandoffItem[]) => JSON.stringify(sealItems('mac', mac.publicKey, items));
    const w = pullWorld(
      [
        {
          id: 7,
          at: '2026-11-18T12:00:00Z',
          workflow: 'fly-provision.yml',
          file: sealed([{ kind: 'keychain', name: 'cw-riverbend-backup-identity', value: SECRET }]),
          tokens: sealed([
            { kind: 'fly-app-token', app: 'cw-riverbend', token: SECRET, notAfter: 2_000_000_000 },
          ]),
        },
      ],
      mac.privateKey,
    );
    expect(pull(w.io)).toBe(0);
    expect(w.stored.map((i) => i.kind)).toEqual(['keychain', 'fly-app-token']);
    expect(w.said.join('')).not.toContain(SECRET);
  });

  it('skips a run already pulled', () => {
    const mac = generateHandoffKeys();
    const w = pullWorld(
      [{ id: 5, at: 'x', workflow: 'fly-provision.yml', file: 'not even json' }],
      mac.privateKey,
      new Set(['5']),
    );
    expect(pull(w.io)).toBe(0);
    expect(w.stored).toEqual([]);
  });

  it('refuses an artifact sealed to another key or another holder, and tries it again next time', () => {
    const mac = generateHandoffKeys();
    const other = generateHandoffKeys();
    const runs: FakeRun[] = [
      {
        id: 1,
        at: 'a',
        workflow: 'fly-provision.yml',
        file: JSON.stringify(
          sealItems('mac', other.publicKey, [{ kind: 'keychain', name: 'cw-x', value: SECRET }]),
        ),
      },
      {
        id: 2,
        at: 'b',
        workflow: 'fly-provision.yml',
        file: JSON.stringify(
          sealItems('fly-org', mac.publicKey, [
            { kind: 'fly-secrets', app: 'cw-saltmarsh', secrets: { A: SECRET } },
          ]),
        ),
      },
    ];
    const w = pullWorld(runs, mac.privateKey);
    expect(pull(w.io)).toBe(1);
    expect(w.stored).toEqual([]);
    expect([...(w.saved() ?? [])]).toEqual([]);
    expect(w.said.join('')).toContain('does not open');
    expect(w.said.join('')).toContain('sealed to fly-org');
  });

  it('opens only runs that main itself started, never a pull request or a fork', () => {
    const mac = generateHandoffKeys();
    // Each envelope is sealed to the real Mac key: a fork that edits a
    // workflow can make one, so the seal proves nothing about who sent it.
    const sealed = () =>
      JSON.stringify(
        sealItems('mac', mac.publicKey, [
          { kind: 'fly-app-token', app: 'cw-harborlight', token: SECRET, notAfter: 2_000_000_000 },
        ]),
      );
    const runs: FakeRun[] = [
      { id: 1, at: 'a', workflow: 'fly-provision.yml', file: sealed(), event: 'pull_request' },
      {
        id: 2,
        at: 'b',
        workflow: 'fly-provision.yml',
        file: sealed(),
        event: 'pull_request_target',
      },
      { id: 3, at: 'c', workflow: 'cloudflare.yml', file: sealed(), repo: 'saltmarsh/fork' },
      { id: 4, at: 'd', workflow: 'cloudflare.yml', file: sealed(), event: 'push' },
      { id: 5, at: 'e', workflow: 'fly-ci-tokens.yml', file: sealed(), event: 'schedule' },
      { id: 6, at: 'f', workflow: 'fly-provision.yml', file: sealed() },
    ];
    const w = pullWorld(runs, mac.privateKey);
    expect(pull(w.io)).toBe(0);
    expect(w.stored).toHaveLength(3);
    expect([...(w.saved() ?? [])].sort()).toEqual(['4', '5', '6']);
    expect(w.said.join('')).not.toContain(' run 1:');
    expect(w.said.join('')).not.toContain(' run 3:');
  });

  it('asks every workflow that hands off', () => {
    const asked: string[] = [];
    const w = pullWorld([], generateHandoffKeys().privateKey);
    const gh = w.io.gh;
    w.io.gh = (args) => {
      asked.push(workflowOf(args));
      return gh(args);
    };
    expect(pull(w.io)).toBe(0);
    expect(asked).toEqual([...WORKFLOWS]);
  });
});

describe('handoff:keygen', () => {
  function world(macKey = false, ghStatus = 0) {
    let recipients = '{"mac":"","fly-org":""}';
    const macKeys: string[] = [];
    const secrets: Array<{ name: string; env: string; value: string }> = [];
    const printed: string[] = [];
    const io: KeygenIo = {
      generate: () => ({ publicKey: 'PUBLIC', privateKey: 'PRIVATE-fixture' }),
      macKeyExists: () => macKey,
      writeMacKey: (k) => macKeys.push(k),
      ghSecretSet: (name, env, value) => {
        secrets.push({ name, env, value });
        return ghStatus;
      },
      readRecipients: () => recipients,
      writeRecipients: (t) => {
        recipients = t;
      },
      out: (s) => printed.push(s),
      err: (s) => printed.push(s),
    };
    return { io, macKeys, secrets, printed, recipients: () => JSON.parse(recipients) };
  }

  it('mac: the private half to the handoff folder, the public half to recipients.json', () => {
    const w = world();
    expect(keygen(['mac'], w.io)).toBe(0);
    expect(w.macKeys).toEqual(['PRIVATE-fixture']);
    expect(w.recipients()).toEqual({ mac: 'PUBLIC', 'fly-org': '' });
    expect(w.printed.join('')).not.toContain('PRIVATE');
  });

  it('mac: refuses to replace a key without --replace', () => {
    const w = world(true);
    expect(keygen(['mac'], w.io)).toBe(1);
    expect(w.macKeys).toEqual([]);
    expect(keygen(['mac', '--replace'], w.io)).toBe(0);
  });

  it('fly-org: the private half to the environment on stdin, never a file', () => {
    const w = world();
    expect(keygen(['fly-org'], w.io)).toBe(0);
    expect(w.secrets).toEqual([
      { name: 'HANDOFF_PRIVATE_KEY', env: 'fly-org', value: 'PRIVATE-fixture' },
    ]);
    expect(w.macKeys).toEqual([]);
    expect(w.recipients()['fly-org']).toBe('PUBLIC');
  });

  it('fly-org: a failed secret write leaves recipients.json as it was', () => {
    const w = world(false, 1);
    expect(keygen(['fly-org'], w.io)).toBe(1);
    expect(w.recipients()['fly-org']).toBe('');
  });
});
