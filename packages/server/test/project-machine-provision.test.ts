/**
 * The deploy scripts once the keeper is retired: which token a `fly` call
 * runs with (`mac-ops.ts flyTokenFor`), the private upload folder, an entry a
 * CI run makes going to the Mac's handoff instead of a Keychain, and the two
 * halves of fly-provision.yml (`provision-outputs.ts` in cloudflare-prod,
 * `provision.ts` in fly-org) and its push keys (`push-keys.ts`).
 *
 * Fakes only: no `fly`, no Cloudflare, no GitHub, no Keychain.
 */
import { describe, expect, it } from 'bun:test';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type HandoffItem,
  HandoffSink,
  openItems,
  sealItems,
} from '../../../infra/handoff/items.ts';
import { generateHandoffKeys } from '../../../infra/handoff/seal.ts';
import {
  appOf,
  flyTokenFor,
  handoffSink,
  keychainCreate,
  keychainRead,
  privateStage,
} from '../../../infra/project-machine/mac-ops.ts';
import { provisionOutputs } from '../../../infra/project-machine/provision-outputs.ts';
import { flushMacHandoff, provisionPresets } from '../../../infra/project-machine/provision.ts';
import { makePushKeys } from '../../../infra/project-machine/push-keys.ts';
import { PUSH_KEYS_ENV } from '../src/git-push/credential.ts';

const SECRET = 'fixture-value-Saltmarsh-0123456789';

describe('which token a fly call runs with', () => {
  it('reads the app a command names', () => {
    expect(appOf(['logs', '--app', 'cw-harborlight', '--no-tail'])).toBe('cw-harborlight');
    expect(appOf(['status', '-a', 'cw-riverbend'])).toBe('cw-riverbend');
    expect(appOf(['deploy', '--app=cw-saltmarsh'])).toBe('cw-saltmarsh');
    expect(appOf(['apps', 'list'])).toBeUndefined();
  });

  it('FLY_API_TOKEN first: CI holds the org token or one app’s', () => {
    const pulls: number[] = [];
    const src = {
      env: { FLY_API_TOKEN: 'ci-token' },
      appToken: () => 'mac-token',
      pull: () => pulls.push(1),
    };
    expect(flyTokenFor(['apps', 'list'], src)).toBe('ci-token');
    expect(pulls).toEqual([]);
  });

  it('on the Mac, the named app’s own token, pulled once when it has none', () => {
    let have: string | null = null;
    const pulls: number[] = [];
    const src = {
      env: {},
      appToken: (app: string) => (app === 'cw-harborlight' ? have : null),
      pull: () => {
        pulls.push(1);
        have = 'pulled-token';
      },
    };
    expect(flyTokenFor(['logs', '--app', 'cw-harborlight'], src)).toBe('pulled-token');
    expect(pulls).toEqual([1]);
    expect(flyTokenFor(['logs', '--app', 'cw-harborlight'], src)).toBe('pulled-token');
    expect(pulls).toEqual([1]);
  });

  it('refuses an org-wide command and an app it has no token for, naming the workflow', () => {
    const src = { env: {}, appToken: () => null, pull: () => {} };
    expect(() => flyTokenFor(['apps', 'create', 'cw-x'], src)).toThrow('fly-provision.yml');
    expect(() => flyTokenFor(['storage', 'create', '--org', 'o'], src)).toThrow('only CI holds');
    expect(() => flyTokenFor(['status', '--app', 'cw-riverbend'], src)).toThrow(
      'fly-ci-tokens.yml',
    );
    expect(() => flyTokenFor(['status', '--app', 'other-app'], src)).toThrow('org token');
  });
});

describe('the upload folder', () => {
  it('is this user’s alone: folder 700, each shared file 600, removed when done', () => {
    const stage = privateStage('cw-harborlight-restore-');
    expect(statSync(stage.dir).mode & 0o777).toBe(0o700);
    const f = join(stage.dir, 'bundle.tgz');
    writeFileSync(f, 'x', { mode: 0o644 });
    stage.share(f);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    stage.done();
    expect(() => statSync(stage.dir)).toThrow();
  });
});

describe('an entry a CI run makes', () => {
  it('is refused without a handoff, and with one goes to it, readable for the rest of the run', () => {
    const saved = { s: process.env.CW_SECRETS_FROM_ENV, o: process.env.CW_HANDOFF_OUT };
    process.env.CW_SECRETS_FROM_ENV = '1';
    try {
      Reflect.deleteProperty(process.env, 'CW_HANDOFF_OUT');
      expect(() => keychainCreate('cw-riverbend-backup-identity', SECRET)).toThrow(
        'CW_HANDOFF_OUT',
      );
      process.env.CW_HANDOFF_OUT = '/fixture/handoff.json';
      keychainCreate('cw-riverbend-backup-identity', SECRET);
      expect(keychainRead('cw-riverbend-backup-identity')).toBe(SECRET);
      expect(handoffSink()?.describe()).toEqual(['Keychain entry cw-riverbend-backup-identity']);
      expect(() => keychainCreate('cw-riverbend-backup-identity', 'again')).toThrow(
        'already exists',
      );
    } finally {
      if (saved.s === undefined) Reflect.deleteProperty(process.env, 'CW_SECRETS_FROM_ENV');
      else process.env.CW_SECRETS_FROM_ENV = saved.s;
      if (saved.o === undefined) Reflect.deleteProperty(process.env, 'CW_HANDOFF_OUT');
      else process.env.CW_HANDOFF_OUT = saved.o;
    }
  });

  it('reaches the Mac sealed, and the log names it without its value', () => {
    const mac = generateHandoffKeys();
    const sink = new HandoffSink('mac', '/fixture/out.json');
    sink.add({ kind: 'keychain', name: 'cw-saltmarsh-bucket-admin', value: SECRET });
    const written: string[] = [];
    const logged: string[] = [];
    const flush = sink.flush.bind(sink);
    sink.flush = (key) => flush(key, (_p, t) => written.push(t));
    flushMacHandoff(
      sink,
      () => mac.publicKey,
      (s) => logged.push(s),
    );
    expect(openItems(mac.privateKey, written[0] ?? '').items).toEqual([
      { kind: 'keychain', name: 'cw-saltmarsh-bucket-admin', value: SECRET },
    ]);
    expect(logged.join('\n')).toContain('cw-saltmarsh-bucket-admin');
    expect(logged.join('\n')).not.toContain(SECRET);
    // Nothing made, nothing written.
    flushMacHandoff(new HandoffSink('mac', '/x'), () => {
      throw new Error('no key asked for');
    });
    flushMacHandoff(null);
  });
});

const TUNNEL_ID = '0123abcd-0000-4000-8000-0123456789ab';
const ACCOUNT = 'a'.repeat(32);
const OUTPUTS = {
  access: { harborlight: { aud: 'aud-harborlight', hosts: ['harborlight.example.test'] } },
  accessTeamDomain: 'team.example.test',
  tunnels: {
    harborlight: {
      account_id: ACCOUNT,
      id: TUNNEL_ID,
      name: 'cw-harborlight',
      origin: 'harborlight-origin.example.test',
      public_host: 'harborlight.example.test',
    },
  },
};

describe('fly-provision.yml, the cloudflare-prod half', () => {
  function world(machines = '{"machines":[{"project":"harborlight"}]}') {
    const flyOrg = generateHandoffKeys();
    const written: string[] = [];
    const printed: string[] = [];
    const read: string[] = [];
    const io = {
      machines: () => machines,
      outputs: () => OUTPUTS,
      tunnelToken: async (t: { id: string }) => {
        read.push(t.id);
        return SECRET;
      },
      recipient: () => flyOrg.publicKey,
      write: (_p: string, t: string) => written.push(t),
      out: (s: string) => printed.push(s),
    };
    return { io, flyOrg, written, printed, read };
  }

  it('seals the tunnel’s token and the Access settings to fly-org, and prints names only', async () => {
    const w = world();
    const env = { CW_PROVISION_HANDOFF_OUT: '/fixture/p.json' };
    expect(await provisionOutputs(['--project', 'harborlight'], env, w.io)).toBe(0);
    expect(w.read).toEqual([TUNNEL_ID]);
    const opened = openItems(w.flyOrg.privateKey, w.written[0] ?? '');
    expect(opened.recipient).toBe('fly-org');
    const item = opened.items[0] as Extract<HandoffItem, { kind: 'fly-secrets' }>;
    expect(item.app).toBe('cw-harborlight');
    expect(item.secrets.CLOUDFLARE_TUNNEL_TOKEN).toBe(SECRET);
    expect(item.secrets.CW_PUBLIC_BASE_URL).toBe('https://harborlight.example.test');
    expect(item.secrets).not.toHaveProperty('CW_OWNER_EMAIL');
    expect(w.printed.join('')).toContain('CLOUDFLARE_TUNNEL_TOKEN');
    expect(w.printed.join('')).not.toContain(SECRET);
    expect(w.written[0]).not.toContain(SECRET);
  });

  it('refuses a project machines.json does not list, before reading a token', async () => {
    const w = world('{"machines":[{"project":"riverbend"}]}');
    const env = { CW_PROVISION_HANDOFF_OUT: '/fixture/p.json' };
    expect(await provisionOutputs(['--project', 'harborlight'], env, w.io)).toBe(1);
    expect(w.read).toEqual([]);
    expect(w.written).toEqual([]);
    expect(await provisionOutputs(['--project', 'harborlight'], {}, w.io)).toBe(2);
  });
});

describe('fly-provision.yml, the fly-org half', () => {
  const flyOrg = generateHandoffKeys();
  const file = (who: 'fly-org' | 'mac', key = flyOrg.publicKey) =>
    JSON.stringify(
      sealItems(who, key, [
        {
          kind: 'fly-secrets',
          app: 'cw-harborlight',
          secrets: { CLOUDFLARE_TUNNEL_TOKEN: SECRET },
        },
      ]),
    );

  it('opens the sealed presets for its app', () => {
    const env = { CW_PROVISION_HANDOFF: '/p.json', HANDOFF_PRIVATE_KEY: flyOrg.privateKey };
    expect(provisionPresets(env, 'cw-harborlight', () => file('fly-org'))).toEqual({
      CLOUDFLARE_TUNNEL_TOKEN: SECRET,
    });
  });

  it('is nothing outside a provisioning run, and refuses a file that is not for it', () => {
    expect(provisionPresets({}, 'cw-harborlight')).toBeUndefined();
    const env = { CW_PROVISION_HANDOFF: '/p.json', HANDOFF_PRIVATE_KEY: flyOrg.privateKey };
    expect(() => provisionPresets({ CW_PROVISION_HANDOFF: '/p.json' }, 'cw-harborlight')).toThrow(
      'HANDOFF_PRIVATE_KEY',
    );
    expect(() => provisionPresets(env, 'cw-riverbend', () => file('fly-org'))).toThrow(
      'nothing for cw-riverbend',
    );
    expect(() => provisionPresets(env, 'cw-harborlight', () => file('mac'))).toThrow(
      'sealed to mac',
    );
    const other = generateHandoffKeys();
    expect(() =>
      provisionPresets(env, 'cw-harborlight', () => file('fly-org', other.publicKey)),
    ).toThrow('does not open');
  });
});

describe('push deploy keys, made in fly-org', () => {
  const REPOS = ['Riverbend/notes', 'Riverbend/app'];

  function deps(failSecret = false) {
    const github: string[] = [];
    const fly: Array<{ args: string[]; input?: string }> = [];
    let id = 10;
    return {
      github,
      fly,
      deps: {
        github: async (method: string, path: string) => {
          github.push(`${method} ${path}`);
          if (method === 'POST') return { status: 201, body: JSON.stringify({ id: ++id }) };
          if (method === 'GET') return { status: 200, body: '[]' };
          return { status: 204, body: '' };
        },
        keygen: async (comment: string) => ({
          privateKey: `PRIVATE-${comment}`,
          publicKey: `ssh-ed25519 AAAA ${comment}`,
        }),
        fly: async (args: string[], input: string | undefined) => {
          fly.push({ args, ...(input === undefined ? {} : { input }) });
          return failSecret ? { status: 1, stderr: 'boom' } : { status: 0, stderr: '' };
        },
      },
    };
  }

  it('registers a key per repo, sets the private halves on the app alone, and reports ids', async () => {
    const d = deps();
    const lines = await makePushKeys('cw-riverbend-test', REPOS, d.deps);
    expect(lines.slice(0, 2)).toEqual([
      'Riverbend/notes: write deploy key 11',
      'Riverbend/app: write deploy key 12',
    ]);
    expect(d.fly).toHaveLength(1);
    expect(d.fly[0]?.args).toEqual(['secrets', 'import', '--app', 'cw-riverbend-test', '--stage']);
    expect(d.fly[0]?.input?.startsWith(`${PUSH_KEYS_ENV}=`)).toBe(true);
    expect(lines.join('\n')).not.toContain('PRIVATE');
  });

  it('deletes every key it registered when the secret cannot be set', async () => {
    const d = deps(true);
    await expect(makePushKeys('cw-riverbend-test', REPOS, d.deps)).rejects.toThrow('no push keys');
    expect(d.github.filter((c) => c.startsWith('DELETE'))).toEqual([
      'DELETE /repos/Riverbend/notes/keys/11',
      'DELETE /repos/Riverbend/app/keys/12',
    ]);
  });

  it('refuses a repo that is not owner/name, and runs without GITHUB_TOKEN never', async () => {
    const d = deps();
    await expect(makePushKeys('cw-riverbend-test', ['../x'], d.deps)).rejects.toThrow('owner/name');
    await expect(makePushKeys('cw-riverbend-test', REPOS, undefined, {})).rejects.toThrow(
      'GITHUB_TOKEN',
    );
    expect(d.github).toEqual([]);
  });
});
