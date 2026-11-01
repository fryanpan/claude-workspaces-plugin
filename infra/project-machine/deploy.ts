#!/usr/bin/env bun
/**
 * Create or update one project's Fly machine and everything it needs.
 *
 *   bun run machine:deploy --project <name> [--dry-run] [--ref <commit>]
 *       [--region sjc] [--memory 512] [--volume-gb 1] [--tunnel quick|named]
 *       [--lead-board <boardId>] [--claude-account <label>]
 *       [--github-deploy-key <keychain entry>] [--refresh-lead]
 *       [--refresh-tunnel-token] [--tf-env prod|staging]
 *
 * Each run reads what exists and does only what is missing, so a second run
 * over a finished project changes nothing:
 *
 *   the app `cw-<name>`, on a private network of its own
 *   its volume `cw_data`
 *   the backup key pair (identity in the Keychain; the machine gets the public half)
 *   the Tigris bucket `cw-<name>-backups` (admin credential in the Keychain)
 *   a write-only credential for it (put objects under snapshots/, nothing else)
 *   a rule that expires snapshots after 30 days, since the machine cannot delete
 *   the machine's secrets, then the image built from <ref> by Fly's builder
 *   the org's Anthropic key as CW_ORG_ANTHROPIC_API_KEY, only when the
 *   Keychain holds `cw-<name>-anthropic-api-key`; without it the server
 *   refuses every Claude call
 *   the lead agent, when the machine has a board to lead (`--lead-board`,
 *   as CW_LEAD_BOARD): its Claude Code sign-in as CLAUDE_CODE_OAUTH_TOKEN
 *   from the Keychain's `claude-lead-oauth-token` (or, with
 *   `--claude-account <label>`, `claude-lead-oauth-token.<label>`), and the
 *   repo's deploy key as CW_LEAD_GITHUB_DEPLOY_KEY from the Keychain entry
 *   `--github-deploy-key` names. A machine with a lead needs `--memory 2048`.
 *   Each is set once, like every secret, except that a run naming its source
 *   sets it again, and `--refresh-lead` sets all three again
 *   the owner's address, the public address and the Access settings
 *   (`settings.ts`), from the Keychain and the Terraform outputs; each one
 *   whose source is missing is skipped with a line saying why
 *
 * With `--tunnel named` it gives the machine the token of the tunnel
 * `cw-<name>` as CLOUDFLARE_TUNNEL_TOKEN. Terraform makes the tunnel, its
 * ingress and its origin hostname (`infra/cloudflare/modules/tunnel`), and
 * this reads the tunnel and its token from `terraform output`
 * (`tunnel-plan.ts`): it makes no Cloudflare call. A tunnel Terraform remade
 * has a new token: `--refresh-tunnel-token` sets it again.
 *
 * In CI (`.github/workflows/cloudflare.yml`) it runs with CW_SECRETS_FROM_ENV=1
 * and every Keychain entry handed in as an environment variable
 * (`mac-ops.ts`). There it only updates a machine the Mac already made: a
 * run that would make an app, a volume or a credential is refused.
 *
 * The image is built from `git archive <ref>`, never the working tree, so no
 * local data dir, node_modules or uncommitted file reaches Fly. Every
 * credential comes out of the Keychain (or, in CI, the environment) into a
 * child's environment or stdin.
 * Why Tigris: README.md.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TfOutputs, readOutputs } from '../cloudflare/outputs.ts';
import { type TfEnv, isEnv } from '../cloudflare/terraform.ts';
import {
  type Action,
  LEAD_BOARD_SECRET,
  LEAD_DEPLOY_KEY_SECRET,
  LEAD_TOKEN_SECRET,
  type ObservedMachine,
  type ProjectConfig,
  type TunnelMode,
  leadMemoryError,
  leadSecrets,
  parseStorageCreate,
  plan,
  projectConfig,
  quickTunnelUrl,
  renderFlyToml,
  writeOnlyPolicy,
} from './deploy-plan.ts';
import { bucketAdmin, secretValue } from './deploy-secrets.ts';
import {
  fly,
  flyJson,
  flyLive,
  flyOk,
  keychainCreate,
  keychainHas,
  keychainRead,
  secretsFromEnv,
} from './mac-ops.ts';
import { type Setting, readSettings } from './settings.ts';
import { generateSnapshotKeys } from './snapshot.ts';
import {
  attachPolicy,
  createAccessKey,
  ensurePolicy,
  hasLifecycle,
  setLifecycle,
} from './tigris.ts';
import { type AppliedTunnel, TUNNEL_TOKEN_SECRET, appliedTunnel } from './tunnel-plan.ts';

const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const PREFIX = 'snapshots/';
const KEEP_DAYS = 30;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function num(v: string | undefined): number | undefined {
  return v === undefined ? undefined : Number(v);
}

function resolveRef(ref: string): string {
  const r = spawnSync('git', ['-C', REPO, 'rev-parse', '--verify', `${ref}^{commit}`], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`no commit ${ref}`);
  return r.stdout.trim();
}

type Named = { Name?: string; name?: string };
const nameOf = (x: Named) => x.Name ?? x.name ?? '';

interface FlyVolume {
  name: string;
  region: string;
  state: string;
}
interface FlyMachine {
  id: string;
  state: string;
  image_ref?: { tag?: string };
  config?: { guest?: { memory_mb?: number } };
  ImageRef?: { Tag?: string };
}

export function machines(app: string): ObservedMachine[] {
  return flyJson<FlyMachine[]>(['machines', 'list', '--app', app]).map((m) => ({
    id: m.id,
    state: m.state,
    imageTag: m.image_ref?.tag ?? m.ImageRef?.Tag ?? '',
    memoryMb: m.config?.guest?.memory_mb ?? 0,
  }));
}

/** The Fly secret each made-once Keychain entry was the source of. */
const madeFrom = (cfg: ProjectConfig): Record<string, string> => ({
  [cfg.keychain.identity]: 'BACKUP_RECIPIENT',
  [cfg.keychain.bucketAdmin]: 'BACKUP_S3_ENDPOINT',
  [cfg.keychain.writer]: 'BACKUP_S3_ACCESS_KEY_ID',
});

async function observe(cfg: ProjectConfig) {
  const app = flyJson<Named[]>(['apps', 'list']).some((a) => nameOf(a) === cfg.app);
  const volumes = app
    ? flyJson<FlyVolume[]>(['volumes', 'list', '--app', cfg.app]).filter(
        (v) => v.name === cfg.volumeName && v.region === cfg.region && v.state !== 'destroyed',
      ).length
    : 0;
  const secrets = new Set(
    app ? flyJson<Named[]>(['secrets', 'list', '--app', cfg.app]).map(nameOf) : [],
  );
  // Off the Mac, a made-once entry counts as made when the secret it was the
  // source of is set: the Mac made it, and CI never needs its value.
  const made = madeFrom(cfg);
  const inferred = (n: string) => secretsFromEnv() && secrets.has(made[n] ?? '');
  const keychain = new Set(
    Object.values(cfg.keychain).filter(
      (n): n is string => n !== undefined && (keychainHas(n) || inferred(n)),
    ),
  );
  // The lifecycle rule is read with the bucket's admin credential, which CI
  // does not hold; the Mac set the rule when it made the bucket.
  const lifecycle = keychainHas(cfg.keychain.bucketAdmin)
    ? await hasLifecycle(bucketAdmin(cfg), cfg.bucket, PREFIX, KEEP_DAYS)
    : inferred(cfg.keychain.bucketAdmin);
  return { app, volumes, keychain, lifecycle, secrets, machines: app ? machines(cfg.app) : [] };
}

function deploy(cfg: ProjectConfig): void {
  // Through the keeper, `fly deploy` runs as the keeper's user, which cannot
  // open this user's temp folder; the context is the public repo at one
  // commit, so it is built where any user may read it.
  const viaKeeper = Boolean(process.env.CW_KEEPER_URL?.trim());
  const ctx = mkdtempSync(join(viaKeeper ? '/tmp' : tmpdir(), `${cfg.app}-build-`));
  if (viaKeeper) chmodSync(ctx, 0o755);
  try {
    const archive = spawnSync(
      'sh',
      ['-c', `git -C "$REPO" archive --format=tar "$REF" | tar -x -C "$CTX"`],
      { stdio: 'inherit', env: { ...process.env, REPO, REF: cfg.imageLabel, CTX: ctx } },
    );
    if (archive.status !== 0) throw new Error('git archive failed');
    const dir = join(ctx, 'infra', 'project-machine');
    const toml = join(dir, 'fly.toml');
    writeFileSync(toml, renderFlyToml(readFileSync(toml, 'utf8'), cfg));
    flyLive([
      'deploy',
      ctx,
      '--app',
      cfg.app,
      '--config',
      join(dir, 'fly.toml'),
      '--dockerfile',
      join(dir, 'Dockerfile'),
      '--remote-only',
      '--ha=false',
      '--no-public-ips',
      '--image-label',
      cfg.imageLabel,
      '--yes',
    ]);
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}

interface RunContext {
  /** The Fly org, read only by the steps that make something. */
  org: () => string;
  /** The per-project settings this run found a source for, by name. */
  settings: ReadonlyMap<string, Setting>;
  /** The tunnel token, when this run has a named tunnel. */
  tunnelToken?: () => string;
}

async function act(cfg: ProjectConfig, a: Action, ctx: RunContext): Promise<void> {
  switch (a.kind) {
    case 'create-app':
      flyOk(['apps', 'create', cfg.app, '--org', ctx.org(), '--network', cfg.network]);
      return;
    case 'create-volume':
      flyOk([
        'volumes',
        'create',
        cfg.volumeName,
        '--app',
        cfg.app,
        '--region',
        cfg.region,
        '--size',
        String(cfg.volumeGb),
        '--yes',
      ]);
      return;
    case 'make-backup-key':
      keychainCreate(cfg.keychain.identity, generateSnapshotKeys().identity);
      return;
    case 'create-bucket': {
      // Not flyOk: this command's output holds the admin credential, so
      // on failure only its error stream is shown.
      const r = fly(['storage', 'create', '--org', ctx.org(), '--name', cfg.bucket, '--yes']);
      if (r.status !== 0) throw new Error(`fly storage create failed: ${r.stderr.trim()}`);
      keychainCreate(cfg.keychain.bucketAdmin, JSON.stringify(parseStorageCreate(r.stdout)));
      return;
    }
    case 'make-writer-key': {
      const admin = bucketAdmin(cfg);
      const key = await createAccessKey(admin);
      const arn = await ensurePolicy(
        admin,
        `${cfg.app}-backup-writer`,
        writeOnlyPolicy(cfg.bucket, PREFIX),
      );
      await attachPolicy(admin, key.accessKeyId, arn);
      keychainCreate(cfg.keychain.writer, JSON.stringify(key));
      return;
    }
    case 'set-lifecycle':
      await setLifecycle(bucketAdmin(cfg), cfg.bucket, PREFIX, KEEP_DAYS);
      return;
    case 'set-secrets': {
      const lines: string[] = [];
      for (const n of a.names) {
        const setting = ctx.settings.get(n);
        if (setting) {
          lines.push(`${n}=${setting.value()}`);
        } else if (n !== TUNNEL_TOKEN_SECRET) {
          lines.push(`${n}=${secretValue(cfg, n)}`);
        } else if (ctx.tunnelToken) {
          lines.push(`${n}=${ctx.tunnelToken()}`);
        } else {
          throw new Error(`no source for secret ${n}`);
        }
      }
      flyOk(['secrets', 'import', '--app', cfg.app, '--stage'], { input: `${lines.join('\n')}\n` });
      return;
    }
    case 'unset-secrets':
      flyOk(['secrets', 'unset', ...a.names, '--app', cfg.app, '--stage']);
      return;
    case 'deploy':
      deploy(cfg);
      // Fly leaves a machine that was stopped before the update stopped
      // after it (a crash loop that hit the restart limit, say).
      for (const m of machines(cfg.app)) {
        if (m.state === 'stopped') flyOk(['machine', 'start', m.id, '--app', cfg.app]);
      }
      return;
    case 'start-machine':
      flyOk(['machine', 'start', a.id, '--app', cfg.app]);
      return;
  }
}

function describe(a: Action): string {
  return a.kind === 'set-secrets' || a.kind === 'unset-secrets'
    ? `${a.kind} ${a.names.join(',')}`
    : a.kind === 'start-machine'
      ? `start-machine ${a.id}`
      : a.kind;
}

export interface DeployOptions {
  /** The Terraform outputs; a test's stand-in. Default: `readOutputs(tfEnv)`. */
  outputs?: () => TfOutputs;
  /** Which Terraform environment's outputs to read. Default prod. */
  tfEnv?: TfEnv;
  /** Set CLOUDFLARE_TUNNEL_TOKEN again, after Terraform remade the tunnel. */
  refreshTunnelToken?: boolean;
}

/** The steps that make an app, a volume or a credential: the Mac's alone. */
const MAKES = new Set([
  'create-app',
  'create-volume',
  'make-backup-key',
  'create-bucket',
  'make-writer-key',
]);

export async function deployProject(
  cfg: ProjectConfig,
  dryRun: boolean,
  opts: DeployOptions = {},
): Promise<Action[]> {
  let cached: TfOutputs | undefined;
  const outputs = () => {
    cached ??= (opts.outputs ?? (() => readOutputs(opts.tfEnv ?? 'prod')))();
    return cached;
  };
  // The outputs are read first: a named tunnel Terraform has not made stops
  // the run before Fly is touched.
  const tunnel: AppliedTunnel | undefined =
    cfg.tunnel === 'named' ? appliedTunnel(outputs(), cfg) : undefined;
  const found = readSettings(cfg.project, { outputs, keychainHas, keychainRead });
  const settings = new Map<string, Setting>(found.settings.map((s) => [s.name, s]));
  // A remade tunnel has a new token, so an existing secret holds the old one.
  const refresh = tunnel && opts.refreshTunnelToken ? [TUNNEL_TOKEN_SECRET] : [];
  const observed = await observe(cfg);
  const actions = plan(cfg, observed, refresh, [...settings.keys()]);
  if (tunnel) console.log(`[deploy] tunnel ${tunnel.name} is ${tunnel.id}, from Terraform`);
  console.log(
    actions.length === 0
      ? `[deploy] ${cfg.app} is up to date at ${cfg.imageLabel.slice(0, 9)}: nothing to do`
      : `[deploy] ${cfg.app}: ${actions.map(describe).join(', ')}`,
  );
  for (const a of actions) {
    if (a.kind !== 'set-secrets') continue;
    for (const n of a.names) {
      const s = settings.get(n);
      if (s) console.log(`[deploy]   ${n} from ${s.from}`);
    }
  }
  for (const line of found.skipped) console.log(`[deploy] not set: ${line}`);
  const tooSmall = leadMemoryError(cfg, observed);
  if (tooSmall) throw new Error(tooSmall);
  const lead = leadSecrets(cfg, observed);
  if (cfg.leadBoard === undefined && !observed.secrets.has(LEAD_BOARD_SECRET))
    console.log(
      `[deploy] not set: ${LEAD_BOARD_SECRET}: no --lead-board, so no lead agent runs on the machine`,
    );
  else if (!lead.includes(LEAD_TOKEN_SECRET) && !observed.secrets.has(LEAD_TOKEN_SECRET))
    console.log(
      `[deploy] not set: ${LEAD_TOKEN_SECRET}: the Keychain has no ${cfg.keychain.leadToken}, so no lead agent runs on the machine`,
    );
  if (
    cfg.leadRefresh.includes(LEAD_DEPLOY_KEY_SECRET) &&
    cfg.keychain.deployKey === undefined &&
    observed.secrets.has(LEAD_DEPLOY_KEY_SECRET)
  )
    console.log(
      `[deploy] not set again: ${LEAD_DEPLOY_KEY_SECRET}: no --github-deploy-key names its source`,
    );
  if (cfg.keychain.deployKey !== undefined && !lead.includes(LEAD_DEPLOY_KEY_SECRET))
    console.log(
      `[deploy] not set: ${LEAD_DEPLOY_KEY_SECRET}: the Keychain has no ${cfg.keychain.deployKey}`,
    );
  const makes = actions.filter((a) => MAKES.has(a.kind)).map((a) => a.kind);
  if (secretsFromEnv() && makes.length > 0) {
    throw new Error(
      `${cfg.app} needs ${makes.join(', ')}, which only a deploy on the Mac makes; run bun run machine:deploy --project ${cfg.project} there first`,
    );
  }
  if (dryRun) return actions;
  const ctx: RunContext = { org: () => keychainRead('fly-org-slug').trim(), settings };
  if (tunnel) ctx.tunnelToken = () => tunnel.token();
  for (const a of actions) {
    console.log(`[deploy] ${describe(a)}`);
    await act(cfg, a, ctx);
  }
  return actions;
}

/**
 * The quick tunnel's address, read from the running machine's own logs once
 * cloudflared prints it. The app's logs also hold the addresses of machines
 * a drill destroyed, so they are filtered to the live one.
 */
export async function tunnelAddress(app: string): Promise<string | null> {
  const id = machines(app).find((m) => m.state === 'started')?.id;
  if (!id) return null;
  for (let i = 0; i < 15; i++) {
    const url = quickTunnelUrl(fly(['logs', '--app', app, '--machine', id, '--no-tail']).stdout);
    if (url) return url;
    await Bun.sleep(2000);
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const project = arg(args, 'project');
  if (!project) {
    console.error('[deploy] --project <name> is required');
    process.exit(2);
  }
  const cfg = projectConfig({
    project,
    imageLabel: resolveRef(arg(args, 'ref') ?? 'HEAD'),
    region: arg(args, 'region'),
    volumeGb: num(arg(args, 'volume-gb')),
    vmMemoryMb: num(arg(args, 'memory')),
    tunnel: arg(args, 'tunnel') as TunnelMode | undefined,
    claudeAccount: arg(args, 'claude-account'),
    githubDeployKey: arg(args, 'github-deploy-key'),
    leadBoard: arg(args, 'lead-board'),
    refreshLead: args.includes('--refresh-lead'),
  });
  const tfEnv = arg(args, 'tf-env') ?? 'prod';
  if (!isEnv(tfEnv)) throw new Error(`--tf-env is prod or staging, not ${tfEnv}`);
  const done = await deployProject(cfg, args.includes('--dry-run'), {
    tfEnv,
    refreshTunnelToken: args.includes('--refresh-tunnel-token'),
  });
  if (args.includes('--dry-run')) return;
  const state = machines(cfg.app).map(
    (m) => `${m.id} ${m.state} ${m.imageTag.slice(0, 9)} ${m.memoryMb}MB`,
  );
  console.log(`[deploy] machines: ${state.join('; ') || 'none'}`);
  if (cfg.tunnel === 'quick' && (done.length > 0 || state.length > 0))
    console.log(`[deploy] tunnel: ${(await tunnelAddress(cfg.app)) ?? 'not in the logs yet'}`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`[deploy] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
