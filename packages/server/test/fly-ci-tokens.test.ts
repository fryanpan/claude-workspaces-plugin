/**
 * `fly:ci-tokens` (infra/project-machine/ci-tokens.ts): which app each token
 * is cut for, what the cut allows, where each token goes, what runs in which
 * mode, and what prints. A fake `fly`, a fake Fly API and a fake terraform;
 * nothing reaches Fly or GitHub. What the Terraform root itself makes is
 * `infra/cloudflare/fly-ci/tests/apply.tftest.hcl`.
 */
import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandoffSink, openItems } from '../../../infra/handoff/items.ts';
import { generateHandoffKeys } from '../../../infra/handoff/seal.ts';
import {
  type Caveat,
  type CiTokensIo,
  MAC_VALID_DAYS,
  NEVER_FEATURES,
  READ_ENVIRONMENT,
  READ_VALID_DAYS,
  STAGING_APP,
  STAGING_ENVIRONMENT,
  USAGE,
  VALID_DAYS,
  attenuateWithFly,
  caveats,
  ciTokens,
  flyAppId,
  orgTokenFrom,
  readCaveats,
} from '../../../infra/project-machine/ci-tokens.ts';
import { allows } from './fly-macaroon.ts';

const GH_TOKEN = 'fixture-gh-token-Harborlight';
const ORG = 'FlyV1 fm2_fixture-org-token-Saltmarsh';
const NOW = Date.UTC(2026, 10, 18);
const IDS: Record<string, string> = {
  'cw-harborlight': '101',
  'cw-riverbend': '202',
  [STAGING_APP]: '303',
};
const cutFor = (id: string) => `FlyV1 fm2_fixture-cut-${id}`;
/** The app ids a cut set names: they sit inside its IfPresent caveat. */
const appsOf = (set: Caveat[]): string[] =>
  set.flatMap((c) =>
    c.type === 'IfPresent'
      ? (c.body.ifs as Caveat[]).flatMap((i) =>
          i.type === 'Apps' ? Object.keys(i.body.apps as object) : [],
        )
      : [],
  );
const nowS = Math.floor(NOW / 1000);

const SHOW = JSON.stringify({
  resource_changes: [
    {
      address: 'github_actions_environment_secret.deploy_token["fly-harborlight"]',
      change: { actions: ['create'] },
    },
  ],
});
const SHOW_DELETE = JSON.stringify({
  resource_changes: [
    {
      address: 'github_repository_environment.fly["fly-saltmarsh"]',
      change: { actions: ['delete'] },
    },
  ],
});

interface Run {
  io: CiTokensIo;
  calls: Array<{ args: string[]; env: Record<string, string> }>;
  cut: Caveat[][];
  printed: () => string;
  removed: string[];
}

function fake(
  opts: {
    env?: Record<string, string | undefined>;
    ids?: Record<string, string | null>;
    attenuate?: (json: string) => { status: number; stdout: string };
    show?: string;
  } = {},
): Run {
  const calls: Run['calls'] = [];
  const cut: Caveat[][] = [];
  const removed: string[] = [];
  let text = '';
  const ids = opts.ids ?? IDS;
  const io: CiTokensIo = {
    env: opts.env ?? { GITHUB_TOKEN: GH_TOKEN },
    projects: () => ['harborlight', 'riverbend'],
    orgToken: () => ORG,
    appId: async (app, token) => {
      expect(token).toBe(ORG);
      return ids[app] ?? null;
    },
    attenuate: (json, token) => {
      expect(token).toBe(ORG);
      const parsed = JSON.parse(json) as Caveat[];
      cut.push(parsed);
      if (opts.attenuate) return opts.attenuate(json);
      return { status: 0, stdout: `${cutFor(appsOf(parsed)[0] ?? '?')}\n` };
    },
    now: () => NOW,
    macSink: null,
    macKey: () => '',
    stateDir: '/fixture/state/fly-ci',
    dataDir: '/fixture/state/fly-ci-data',
    terraform: (args, env) => {
      calls.push({ args, env });
      return { status: 0, stdout: args[0] === 'show' ? (opts.show ?? SHOW) : '' };
    },
    removeFile: (p) => removed.push(p),
    out: (s) => {
      text += s;
    },
    err: (s) => {
      text += s;
    },
  };
  return { io, calls, cut, printed: () => text, removed };
}

const verbs = (r: Run) => r.calls.map((c) => c.args[0]);
const tokensHanded = (r: Run) =>
  JSON.parse(r.calls[0]?.env.TF_VAR_deploy_tokens ?? '{}') as Record<string, string>;

describe('fly:ci-tokens', () => {
  it('cuts one token per app, each into its own environment, and prints none', async () => {
    const r = fake();
    expect(await ciTokens(['apply'], r.io)).toBe(0);
    expect(tokensHanded(r)).toEqual({
      'fly-harborlight': cutFor('101'),
      'fly-riverbend': cutFor('202'),
      [STAGING_ENVIRONMENT]: cutFor('303'),
    });
    expect(verbs(r)).toEqual(['init', 'plan', 'show', 'apply']);
    const all = JSON.stringify(r.calls.map((c) => c.args)) + r.printed();
    for (const secret of [ORG, cutFor('101'), cutFor('202'), cutFor('303'), GH_TOKEN])
      expect(all).not.toContain(secret);
    // The org token reaches terraform in no form.
    expect(JSON.stringify(r.calls.map((c) => c.env))).not.toContain('fixture-org-token');
  });

  it('allows each token its one app and the builder, never WireGuard, for 90 days', async () => {
    const r = fake();
    await ciTokens(['plan'], r.io);
    // The read token (every app, `0`) has its own tests below.
    const deployCuts = r.cut.filter((c) => !appsOf(c).includes('0'));
    expect(deployCuts).toHaveLength(3);
    const ids = ['101', '202', '303'];
    for (const [i, set] of deployCuts.entries()) {
      const appId = ids[i] as string;
      expect(appsOf(set)).toEqual([appId]);
      expect(allows(set, { appId, action: 'rwcdC', now: nowS })).toBe(true);
      expect(allows(set, { feature: 'builder', action: 'rwcdC', now: nowS })).toBe(true);
      for (const other of ids.filter((x) => x !== appId))
        expect(allows(set, { appId: other, action: 'r', now: nowS })).toBe(false);
      for (const feature of NEVER_FEATURES)
        expect(allows(set, { feature, action: 'r', now: nowS })).toBe(false);
      const last = nowS + VALID_DAYS * 86_400;
      expect(allows(set, { appId, action: 'r', now: last })).toBe(true);
      expect(allows(set, { appId, action: 'r', now: last + 1 })).toBe(false);
    }
  });

  it('skips an app the org does not have, and refuses the deletion that follows without --drop', async () => {
    const r = fake({ ids: { ...IDS, 'cw-riverbend': null }, show: SHOW_DELETE });
    expect(await ciTokens(['apply'], r.io)).toBe(1);
    expect(Object.keys(tokensHanded(r))).not.toContain('fly-riverbend');
    expect(r.printed()).toContain('cw-riverbend: the org has no such app');
    expect(r.printed()).toContain('pass --drop');
    expect(verbs(r)).toEqual(['init', 'plan', 'show']);

    const dropped = fake({ ids: { ...IDS, 'cw-riverbend': null }, show: SHOW_DELETE });
    expect(await ciTokens(['apply', '--drop'], dropped.io)).toBe(0);
    expect(verbs(dropped)).toEqual(['init', 'plan', 'show', 'apply']);
  });

  it('refuses an attenuate that failed, or that printed the org token back, before terraform', async () => {
    for (const answer of [
      { status: 1, stdout: '' },
      { status: 0, stdout: `${ORG}\n` },
      { status: 0, stdout: 'two\nlines\n' },
    ]) {
      const r = fake({ attenuate: () => answer });
      expect(await ciTokens(['apply'], r.io)).toBe(1);
      expect(r.calls).toEqual([]);
      expect(r.printed()).not.toContain('fixture-org-token');
    }
  });

  it('plans without applying, and removes the saved plan before and after', async () => {
    const r = fake();
    expect(await ciTokens(['plan'], r.io)).toBe(0);
    expect(verbs(r)).toEqual(['init', 'plan', 'show']);
    expect(r.removed).toEqual([
      '/fixture/state/fly-ci/fly-ci.tfplan',
      '/fixture/state/fly-ci/fly-ci.tfplan',
    ]);
  });

  it('needs GITHUB_TOKEN and a mode, and runs nothing without them', async () => {
    const none = fake({ env: {} });
    expect(await ciTokens(['apply'], none.io)).toBe(1);
    expect(none.cut).toEqual([]);
    expect(none.calls).toEqual([]);
    const bad = fake();
    expect(await ciTokens(['destroy'], bad.io)).toBe(2);
    expect(bad.printed()).toBe(USAGE);
  });

  it('refuses an app id that is not a number', () => {
    expect(() => caveats('101; rm', NOW)).toThrow('a number');
  });
});

describe("Fly's app id", () => {
  const answering = (status: number, body: unknown, seen: Request[] = []) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;

  it('asks for the one app by name, sending a FlyV1 token as is and any other as Bearer', async () => {
    const seen: Request[] = [];
    const f = answering(200, { data: { app: { internalNumericId: 101 } } }, seen);
    expect(await flyAppId('cw-harborlight', ORG, f)).toBe('101');
    expect(await flyAppId('cw-harborlight', 'fixture-bare-token', f)).toBe('101');
    expect(seen.map((q) => q.headers.get('authorization'))).toEqual([
      ORG,
      'Bearer fixture-bare-token',
    ]);
    const body = (await seen[0]?.json()) as { variables: { name: string } };
    expect(body.variables).toEqual({ name: 'cw-harborlight' });
  });

  it('answers null for an app the org does not have, and throws on anything else', async () => {
    const missing = answering(200, {
      data: { app: null },
      errors: [{ message: 'Could not find App' }],
    });
    expect(await flyAppId('cw-saltmarsh', ORG, missing)).toBeNull();
    await expect(flyAppId('cw-saltmarsh', ORG, answering(500, {}))).rejects.toThrow('answered 500');
    await expect(flyAppId('cw-saltmarsh', ORG, answering(200, { data: {} }))).rejects.toThrow(
      'no id',
    );
  });
});

describe('attenuate and the org token', () => {
  it('runs `fly tokens attenuate` with the caveats on stdin and the token in its environment only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fly-ci-tokens-'));
    const bin = join(dir, 'fly');
    writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\n[ "$FLY_API_TOKEN" = "${ORG}" ] && echo 'FlyV1 fm2_fixture-cut'\n`,
    );
    chmodSync(bin, 0o755);
    const json = JSON.stringify(caveats('101', NOW));
    const r = attenuateWithFly(json, ORG, bin);
    expect(r).toEqual({ status: 0, stdout: 'FlyV1 fm2_fixture-cut\n' });
    expect(readFileSync(join(dir, 'argv'), 'utf8')).toBe('tokens\nattenuate\n');
    expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe(json);
  });

  it('takes the org token from FLY_API_TOKEN alone: no Keychain, no keeper', () => {
    expect(orgTokenFrom({ FLY_API_TOKEN: ORG })).toBe(ORG);
    expect(() => orgTokenFrom({})).toThrow('only in the fly-org environment');
    expect(() => orgTokenFrom({ CW_KEEPER_URL: 'http://127.0.0.1:8799' })).toThrow('fly-org');
  });
});

describe('fly:ci-tokens, the Mac’s tokens', () => {
  const MAC_KEY = generateHandoffKeys();
  const withSink = (mode: 'apply' | 'plan') => {
    const r = fake();
    const written: string[] = [];
    const sink = new HandoffSink('mac', '/fixture/handoff.json');
    r.io.macSink = sink;
    r.io.macKey = () => MAC_KEY.publicKey;
    const origFlush = sink.flush.bind(sink);
    sink.flush = (key) => origFlush(key, (_p, text) => written.push(text));
    return { r, written, mode };
  };

  it('an apply cuts one token per project app for the Mac, with wg, for 14 days, sealed to it', async () => {
    const { r, written } = withSink('apply');
    expect(await ciTokens(['apply'], r.io)).toBe(0);
    const wg = { feature: 'wg', action: 'rwcdC', now: nowS };
    const macCuts = r.cut.filter((c) => allows(c, wg));
    expect(macCuts.map(appsOf)).toEqual([['101'], ['202']]);
    const last = nowS + MAC_VALID_DAYS * 86_400;
    expect(allows(macCuts[0] ?? [], { appId: '101', action: 'r', now: last })).toBe(true);
    expect(allows(macCuts[0] ?? [], { appId: '101', action: 'r', now: last + 1 })).toBe(false);
    // CI's own tokens still carry no wg.
    expect(allows(caveats('101', NOW), wg)).toBe(false);
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain('fixture-cut');
    const opened = openItems(MAC_KEY.privateKey, written[0] ?? '');
    expect(opened.items.map((i) => (i.kind === 'fly-app-token' ? i.app : i.kind))).toEqual([
      'cw-harborlight',
      'cw-riverbend',
    ]);
    expect(r.printed()).not.toContain('fixture-cut');
  });

  it('in a GitHub Actions run, every token it cuts is masked before it is used', async () => {
    const { r } = withSink('apply');
    r.io.env = { GITHUB_TOKEN: GH_TOKEN, GITHUB_ACTIONS: 'true' };
    expect(await ciTokens(['apply'], r.io)).toBe(0);
    const masks = r
      .printed()
      .split('\n')
      .filter((l) => l.startsWith('::add-mask::'));
    for (const id of ['101', '202', '303']) expect(masks).toContain(`::add-mask::${cutFor(id)}`);
    // Every value cut: CI's three, the read token and the Mac's two.
    expect(masks).toHaveLength(r.cut.length);
  });

  it('a plan cuts none for the Mac and seals nothing', async () => {
    const { r, written } = withSink('plan');
    expect(await ciTokens(['plan'], r.io)).toBe(0);
    // CI's three and the read token.
    expect(r.cut).toHaveLength(4);
    expect(written).toEqual([]);
  });

  it('an apply with no Mac key committed runs nothing', async () => {
    const { r } = withSink('apply');
    r.io.macKey = () => {
      throw new Error('infra/handoff/recipients.json has no key for mac');
    };
    expect(await ciTokens(['apply'], r.io)).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.cut).toEqual([]);
  });
});

describe('fly:ci-tokens, the read token (wall-off review H1, M5)', () => {
  const readCut = (r: Run) => r.cut.find((c) => appsOf(c).includes('0'));

  it('cuts one token that reads every app and the org and changes nothing, for 14 days', async () => {
    const r = fake();
    expect(await ciTokens(['plan'], r.io)).toBe(0);
    const set = readCut(r);
    if (!set) throw new Error('no read token was cut');
    expect(set).toEqual(readCaveats(NOW));
    // `fly apps list` and each app's network: reads that name the org, or an app.
    expect(allows(set, { action: 'r', now: nowS })).toBe(true);
    for (const appId of ['101', '202', '303'])
      expect(allows(set, { appId, action: 'r', now: nowS })).toBe(true);
    // Nothing that writes: no deploy, no machine control, no WireGuard, so no `fly ssh`.
    for (const appId of ['101', '202'])
      for (const action of ['w', 'c', 'd', 'C'])
        expect(allows(set, { appId, action, now: nowS })).toBe(false);
    for (const feature of ['wg', 'builder', ...NEVER_FEATURES])
      for (const action of ['w', 'c', 'd', 'C'])
        expect(allows(set, { feature, action, now: nowS })).toBe(false);
    for (const action of ['w', 'c', 'd', 'C'])
      expect(allows(set, { action, now: nowS })).toBe(false);
    const last = nowS + READ_VALID_DAYS * 86_400;
    expect(allows(set, { action: 'r', now: last })).toBe(true);
    expect(allows(set, { action: 'r', now: last + 1 })).toBe(false);
  });

  it('hands it to terraform for its own environment, never among the deploy tokens, and prints it nowhere', async () => {
    const r = fake({
      attenuate: (json) => ({
        status: 0,
        stdout: `${cutFor(appsOf(JSON.parse(json) as Caveat[])[0] ?? '?')}\n`,
      }),
    });
    r.io.env = { GITHUB_TOKEN: GH_TOKEN, GITHUB_ACTIONS: 'true' };
    expect(await ciTokens(['apply'], r.io)).toBe(0);
    expect(READ_ENVIRONMENT).toBe('fly-org-read');
    expect(r.calls[0]?.env.TF_VAR_read_token).toBe(cutFor('0'));
    expect(Object.values(tokensHanded(r))).not.toContain(cutFor('0'));
    expect(r.printed()).toContain(`::add-mask::${cutFor('0')}`);
    const unmasked = r
      .printed()
      .split('\n')
      .filter((l) => !l.startsWith('::add-mask::'))
      .join('\n');
    expect(unmasked).not.toContain(cutFor('0'));
    expect(unmasked).toContain(`${READ_ENVIRONMENT}: a read-only token`);
  });

  it('refuses a read cut that failed or printed the org token back, before terraform', async () => {
    for (const answer of [
      { status: 1, stdout: '' },
      { status: 0, stdout: `${ORG}\n` },
    ]) {
      const r = fake({
        attenuate: (json) =>
          appsOf(JSON.parse(json) as Caveat[]).includes('0')
            ? answer
            : { status: 0, stdout: `${cutFor(appsOf(JSON.parse(json) as Caveat[])[0] ?? '?')}\n` },
      });
      expect(await ciTokens(['apply'], r.io)).toBe(1);
      expect(r.calls).toEqual([]);
      expect(r.printed()).not.toContain('fixture-org-token');
    }
  });

  it('refuses a project whose environment would be the read token’s', async () => {
    const r = fake();
    r.io.projects = () => ['harborlight', 'org-read'];
    expect(await ciTokens(['apply'], r.io)).toBe(1);
    expect(r.cut).toEqual([]);
    expect(r.calls).toEqual([]);
    expect(r.printed()).toContain('org-read');
  });
});
