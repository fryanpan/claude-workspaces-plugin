/**
 * The keeper's own Terraform run (`infra/cloudflare/keeper-run.ts`): a plan
 * reports text, summary and missing tokens and removes its file; there is no
 * apply mode, because applies run in CI; `tokens` makes exactly the tokens a
 * config sync's approval named. The configs are the requester's, the committed tfvars
 * the release's, and the token is in terraform's environment and never an
 * argument. The run imports nothing outside `infra/` and no package, because
 * the keeper's release has no `node_modules`. A fake account and a fake
 * terraform; nothing calls Cloudflare.
 */
import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type KeeperRunInput,
  type KeeperRunIo,
  MAX_TEXT,
  keeperRun,
  realKeeperIo,
} from '../../../infra/cloudflare/keeper-run.ts';
import { envDir } from '../../../infra/cloudflare/terraform.ts';
import type { CloudflareApi } from '../../../infra/project-machine/cloudflare.ts';

const ZONE = 'harborlight.test';
const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'fixture-token-Riverbend-0000000000';
const SECRET = 'feedface'.repeat(8);
const TFVARS =
  'name_prefix = ""\nrouter_script_name = "board-router"\nshare_link_script_name = "share-link-gate"\n';

const input = (tokens: string[], extra: Partial<KeeperRunInput> = {}): KeeperRunInput => ({
  configs: {
    router: JSON.stringify({
      zone: ZONE,
      oneAddress: `workspaces.${ZONE}`,
      projects: { riverbend: `mac-origin.${ZONE}` },
    }),
    access: JSON.stringify({
      projects: { riverbend: { hosts: [`riverbend-workspaces.${ZONE}`], serviceTokens: tokens } },
    }),
  },
  state: { accessKeyId: 'fixture-r2-id', secretAccessKey: 'fixture-r2-secret' },
  ...extra,
});

interface World {
  io: KeeperRunIo;
  tf: Array<{ args: string[]; env: Record<string, string> }>;
  files: Record<string, string>;
  removed: string[];
  posts: string[];
  released: string[];
}

interface WorldOpts {
  changes?: number;
  tfvarsInRelease?: boolean;
  /** Extra resource changes in `terraform show -json`. */
  more?: unknown[];
  /** What `terraform show -no-color` prints. */
  planText?: string;
}

const ALICE = 'alice@harborlight.test';
const BOB = 'bob@harborlight.test';
/** A people policy whose sign-in list gains Alice and loses Bob. */
const PEOPLE_CHANGE = {
  address: 'module.stack.module.access.cloudflare_zero_trust_access_policy.people["riverbend"]',
  mode: 'managed',
  type: 'cloudflare_zero_trust_access_policy',
  name: 'people',
  index: 'riverbend',
  change: {
    actions: ['update'],
    before: { include: [{ email: { email: BOB }, email_domain: null }] },
    after: { include: [{ email: { email: ALICE }, email_domain: null }] },
  },
};

function world(opts: WorldOpts = {}): World {
  const w: World = {
    tf: [],
    files: {},
    removed: [],
    posts: [],
    released: [],
    io: undefined as never,
  };
  const answer = (path: string): unknown => {
    const p = path.split('?')[0] ?? '';
    if (p === '/zones') return [{ id: 'f'.repeat(32), account: { id: ACCOUNT } }];
    if (p.endsWith('/ssl/certificate_packs')) return [{ hosts: [ZONE, `*.${ZONE}`] }];
    if (p.endsWith('/dns_records')) {
      return [{ id: 'm', type: 'CNAME', name: `mac-origin.${ZONE}`, content: 'x', proxied: true }];
    }
    return [];
  };
  const api = (async (method: string, path: string, body?: unknown) => {
    if (method === 'POST') {
      w.posts.push((body as { name: string }).name);
      return { id: 'token-1', client_id: 'c0ffee.access', client_secret: SECRET };
    }
    return answer(path);
  }) as CloudflareApi;
  api.all = async <T>(path: string) => answer(path) as T[];
  const changes = opts.changes ?? 1;
  w.io = {
    token: TOKEN,
    readRelease: (rel) => {
      w.released.push(rel);
      return rel === join('infra', 'cloudflare', 'deploys', 'prod', 'terraform.tfvars') &&
        opts.tfvarsInRelease !== false
        ? TFVARS
        : null;
    },
    api: (t) => {
      expect(t).toBe(TOKEN);
      return api;
    },
    writeState: (name, content) => {
      w.files[name] = content;
      return `/work/${name}`;
    },
    statePath: (name) => `/work/${name}`,
    removeState: (name) => w.removed.push(name),
    terraform: (args, env) => {
      w.tf.push({ args, env });
      if (args[0] === 'show' && args[1] === '-json') {
        const rc = Array.from({ length: changes }, (_, i) => ({
          address: `cloudflare_dns_record.r${i}`,
          mode: 'managed',
          change: { actions: ['update'] },
        }));
        const all = [...rc, ...(opts.more ?? [])];
        return { status: 0, stdout: JSON.stringify({ resource_changes: all }) };
      }
      if (args[0] === 'show') {
        return { status: 0, stdout: opts.planText ?? 'Plan: 0 to add, 1 to change.\n' };
      }
      if (args[0] === 'output') return { status: 0, stdout: '{}' };
      return { status: 0, stdout: '' };
    },
  };
  return w;
}

const argsOf = (w: World) => w.tf.map((t) => t.args.join(' ')).join('\n');

/** The plan file the run wrote, by the name it gave terraform. */
const planFileOf = (w: World) =>
  (w.tf[1]?.args.find((a) => a.startsWith('-out=')) ?? '').replace('-out=/work/', '');

describe('keeperRun plan', () => {
  it('reports its text, summary and changes, and removes its plan file', async () => {
    const w = world({ changes: 2 });
    const r = await keeperRun('plan', 'prod', input([], { access: true }), w.io);
    expect(r).toMatchObject({ ok: true, mode: 'plan', changes: 2, missing: {} });
    expect(r.ok && r.mode === 'plan' && r.text).toBe('Plan: 0 to add, 1 to change.\n');
    expect(w.tf.map((t) => t.args[0])).toEqual(['init', 'plan', 'show', 'show']);
    expect(planFileOf(w)).toMatch(/^plan-[A-Za-z0-9_-]{24}\.tfplan$/);
    expect(w.tf[1]?.args).toContain('-lock=false');
    expect(w.removed).toEqual([planFileOf(w)]);
  });

  it('puts the token in terraform environment and never in an argument or a file', async () => {
    const w = world();
    await keeperRun('plan', 'prod', input([]), w.io);
    expect(argsOf(w)).not.toContain(TOKEN);
    expect(JSON.stringify(w.files)).not.toContain(TOKEN);
    for (const t of w.tf) expect(t.env.CLOUDFLARE_API_TOKEN).toBe(TOKEN);
    expect(w.tf[0]?.env.AWS_ACCESS_KEY_ID).toBe('fixture-r2-id');
  });

  it('names a missing service token and makes nothing', async () => {
    const minting = world();
    const r = await keeperRun('plan', 'prod', input(['agent moi'], { access: true }), minting.io);
    expect(r).toMatchObject({ ok: true, missing: { 'agent moi': 'agent moi' } });
    expect(minting.posts).toEqual([]);
    expect(minting.removed).toEqual([planFileOf(minting)]);
  });

  it("reads the committed tfvars from the release, never from the requester's input", async () => {
    const w = world({ tfvarsInRelease: false });
    await expect(keeperRun('plan', 'prod', input([]), w.io)).rejects.toThrow(
      'deploys/prod/terraform.tfvars is missing',
    );
    expect(w.released).toContain(
      join('infra', 'cloudflare', 'deploys', 'prod', 'terraform.tfvars'),
    );
  });

  it("reports, when asked, who a plan adds to and removes from each project's sign-in list", async () => {
    const w = world({ more: [PEOPLE_CHANGE] });
    const r = await keeperRun('plan', 'prod', input([], { access: true }), w.io);
    expect(r.ok && r.mode === 'plan' && r.access).toEqual([
      { project: 'riverbend', added: [ALICE], removed: [BOB] },
    ]);
  });

  it('leaves the sign-in changes out of a plan not asked for them, whose report goes to the requester', async () => {
    const w = world({ more: [PEOPLE_CHANGE] });
    const r = await keeperRun('plan', 'prod', input([]), w.io);
    expect(r.ok && r.mode === 'plan').toBe(true);
    expect(JSON.stringify(r)).not.toContain(ALICE);
  });

  it('removes its plan file when it cannot read who a plan lets sign in', async () => {
    const unread = { ...PEOPLE_CHANGE, change: { ...PEOPLE_CHANGE.change, after: {} } };
    const w = world({ more: [unread] });
    await expect(keeperRun('plan', 'prod', input([], { access: true }), w.io)).rejects.toThrow(
      'the plan does not say who can sign in to riverbend',
    );
    expect(w.removed).toEqual([planFileOf(w)]);
  });

  it('marks text cut at the limit', async () => {
    const w = world({ planText: 'x'.repeat(MAX_TEXT + 10) });
    const r = await keeperRun('plan', 'prod', input([]), w.io);
    expect(r.ok && r.mode === 'plan' && r.cut).toEqual({ shown: MAX_TEXT, total: MAX_TEXT + 10 });
    expect(r.ok && r.mode === 'plan' && r.text.length).toBe(MAX_TEXT);
    const whole = world({ planText: 'x'.repeat(MAX_TEXT) });
    const full = await keeperRun('plan', 'prod', input([]), whole.io);
    expect(full.ok && full.mode === 'plan' && full.cut).toBeUndefined();
  });

  it("plans from the requester's configs, not from any config file in the release", async () => {
    const w = world();
    await keeperRun('plan', 'prod', input([]), w.io);
    expect(w.released).not.toContain(join('infra', 'access-apps', 'access.local.json'));
    expect(w.released).not.toContain(join('infra', 'board-router-worker', 'router.local.json'));
    // The requester's hosts reached the tfvars terraform reads.
    expect(Object.values(w.files).join('\n')).toContain(`riverbend-workspaces.${ZONE}`);
  });

  it('names its plan file itself, whatever the input carries', async () => {
    const w = world();
    const odd = { ...input([]), planId: '../../x' } as KeeperRunInput;
    await keeperRun('plan', 'prod', odd, w.io);
    expect(planFileOf(w)).not.toContain('..');
    expect(w.tf.some((t) => t.args[0] === 'apply')).toBe(false);
  });
});

describe('keeperRun tokens', () => {
  it('makes exactly the approved tokens and reports their pairs', async () => {
    const w = world();
    const r = await keeperRun(
      'tokens',
      'prod',
      input(['agent moi'], { expect: { 'agent moi': 'agent moi' } }),
      w.io,
    );
    expect(w.posts).toEqual(['agent moi']);
    expect(r).toEqual({
      ok: true,
      mode: 'tokens',
      minted: [
        {
          name: 'agent moi',
          id: 'token-1',
          services: {
            clientId: 'cw-agent-moi-access-client-id',
            secret: 'cw-agent-moi-access-secret',
          },
          clientId: 'c0ffee.access',
          secret: SECRET,
        },
      ],
    });
    expect(w.tf).toEqual([]);
  });

  it('makes nothing when the missing tokens differ from what was approved', async () => {
    const w = world();
    const r = await keeperRun(
      'tokens',
      'prod',
      input(['agent moi', 'agent two'], { expect: { 'agent moi': 'agent moi' } }),
      w.io,
    );
    expect(r).toMatchObject({ ok: false });
    expect(w.posts).toEqual([]);
  });
});

describe("the keeper's release can run it", () => {
  it('imports only node built-ins and files under infra/', async () => {
    const root = join(import.meta.dir, '..', '..', '..');
    const built = await Bun.build({
      entrypoints: [join(root, 'infra', 'cloudflare', 'keeper-run.ts')],
      target: 'bun',
      packages: 'external',
      metafile: true,
    });
    expect(built.success).toBe(true);
    const inputs = built.metafile?.inputs ?? {};
    const outside = Object.keys(inputs).filter((p) => !p.startsWith('infra/'));
    const packages = Object.values(inputs)
      .flatMap((v) => v.imports)
      .filter((i) => i.external && !i.path.startsWith('node:') && !/^[a-z_]+$/.test(i.path))
      .map((i) => i.path);
    expect(outside).toEqual([]);
    expect(packages).toEqual([]);
  });
});

describe("the keeper's terraform", () => {
  it('runs the fixed binary in the release root, with direct downloads only and its own folders', () => {
    const work = mkdtempSync(join(tmpdir(), 'keeper-run-io-'));
    try {
      const seen = join(work, 'seen');
      const bin = join(work, 'terraform');
      writeFileSync(
        bin,
        `#!/bin/sh\n{ echo "ARGV $*"; echo "CWD $(pwd)"; echo "UMASK $(umask)"; env | sort; } > "${seen}"\n`,
      );
      chmodSync(bin, 0o755);
      const io = realKeeperIo('prod', work, bin);
      io.writeState('backend.hcl', 'x');
      const r = io.terraform(['version'], { CLOUDFLARE_API_TOKEN: TOKEN });
      expect(r.status).toBe(0);
      const out = readFileSync(seen, 'utf8');
      expect(out).toContain('ARGV version');
      // A saved plan holds the Access addresses: nothing terraform writes is readable by others.
      expect(out).toContain('UMASK 0077');
      expect(out).toContain(`CWD ${envDir('prod')}`);
      expect(out).toContain(`TF_DATA_DIR=${join(work, 'prod-data')}`);
      expect(out).toContain(`TF_CLI_CONFIG_FILE=${join(work, 'terraformrc')}`);
      expect(readFileSync(join(work, 'terraformrc'), 'utf8')).toBe(
        'provider_installation {\n  direct {}\n}\n',
      );
      // The saved files are 600, and terraform's own folder stays one it can open.
      expect(statSync(join(work, 'prod', 'backend.hcl')).mode & 0o777).toBe(0o600);
      expect(statSync(join(work, 'prod-data')).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
