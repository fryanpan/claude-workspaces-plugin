#!/usr/bin/env bun
/**
 * Create or update one project's Fly machine and everything it needs.
 *
 *   bun run machine:deploy --project <name> [--dry-run] [--ref <commit>]
 *       [--region sjc] [--memory 512] [--volume-gb 1] [--tunnel quick|named]
 *       [--router-config <path>]
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
 *
 * With `--tunnel named` it first sets up the project's Cloudflare tunnel
 * `cw-<name>`, its ingress and its origin hostname (`tunnel.ts`), then gives
 * the machine the tunnel's token as CLOUDFLARE_TUNNEL_TOKEN.
 *
 * The image is built from `git archive <ref>`, never the working tree, so no
 * local data dir, node_modules or uncommitted file reaches Fly. Every
 * credential comes out of the Keychain into a child's environment or stdin.
 * Why Tigris: README.md.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type Action,
  type BucketCredential,
  ORG_KEY_SECRET,
  type ObservedMachine,
  type ProjectConfig,
  type TunnelMode,
  parseStorageCreate,
  plan,
  projectConfig,
  quickTunnelUrl,
  renderFlyToml,
  writeOnlyPolicy,
} from './deploy-plan.ts';
import {
  fly,
  flyJson,
  flyLive,
  flyOk,
  keychainCreate,
  keychainHas,
  keychainRead,
} from './mac-ops.ts';
import { generateSnapshotKeys, recipientOf } from './snapshot.ts';
import {
  attachPolicy,
  createAccessKey,
  ensurePolicy,
  hasLifecycle,
  setLifecycle,
} from './tigris.ts';
import { TUNNEL_TOKEN_SECRET } from './tunnel-plan.ts';
import { type NamedTunnel, prepareTunnel, routerNames } from './tunnel.ts';

const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const PREFIX = 'snapshots/';
const KEEP_DAYS = 30;
const ROUTER_CONFIG = join(REPO, 'infra', 'board-router-worker', 'router.local.json');

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

export function bucketAdmin(cfg: ProjectConfig): BucketCredential {
  return JSON.parse(keychainRead(cfg.keychain.bucketAdmin)) as BucketCredential;
}

async function observe(cfg: ProjectConfig) {
  const app = flyJson<Named[]>(['apps', 'list']).some((a) => nameOf(a) === cfg.app);
  const volumes = app
    ? flyJson<FlyVolume[]>(['volumes', 'list', '--app', cfg.app]).filter(
        (v) => v.name === cfg.volumeName && v.region === cfg.region && v.state !== 'destroyed',
      ).length
    : 0;
  const keychain = new Set(Object.values(cfg.keychain).filter((n) => keychainHas(n)));
  const lifecycle = keychain.has(cfg.keychain.bucketAdmin)
    ? await hasLifecycle(bucketAdmin(cfg), cfg.bucket, PREFIX, KEEP_DAYS)
    : false;
  const secrets = new Set(
    app ? flyJson<Named[]>(['secrets', 'list', '--app', cfg.app]).map(nameOf) : [],
  );
  return { app, volumes, keychain, lifecycle, secrets, machines: app ? machines(cfg.app) : [] };
}

function secretValue(cfg: ProjectConfig, name: string): string {
  switch (name) {
    case 'BACKUP_RECIPIENT':
      return recipientOf(keychainRead(cfg.keychain.identity));
    case 'BACKUP_S3_ENDPOINT':
      return bucketAdmin(cfg).endpoint;
    case 'BACKUP_S3_BUCKET':
      return cfg.bucket;
    case 'BACKUP_S3_ACCESS_KEY_ID':
      return (JSON.parse(keychainRead(cfg.keychain.writer)) as { accessKeyId: string }).accessKeyId;
    case 'BACKUP_S3_SECRET_ACCESS_KEY':
      return (JSON.parse(keychainRead(cfg.keychain.writer)) as { secretAccessKey: string })
        .secretAccessKey;
    case 'CW_TUNNEL_MODE':
      return cfg.tunnel;
    case ORG_KEY_SECRET:
      return keychainRead(cfg.keychain.orgKey).trim();
    default:
      throw new Error(`no source for secret ${name}`);
  }
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
  org: string;
  /** The tunnel token, when this run has a named tunnel. */
  tunnelToken?: () => Promise<string>;
}

async function act(cfg: ProjectConfig, a: Action, ctx: RunContext): Promise<void> {
  const { org } = ctx;
  switch (a.kind) {
    case 'create-app':
      flyOk(['apps', 'create', cfg.app, '--org', org, '--network', cfg.network]);
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
      const r = fly(['storage', 'create', '--org', org, '--name', cfg.bucket, '--yes']);
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
        if (n !== TUNNEL_TOKEN_SECRET) {
          lines.push(`${n}=${secretValue(cfg, n)}`);
        } else if (ctx.tunnelToken) {
          lines.push(`${n}=${await ctx.tunnelToken()}`);
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

export async function deployProject(
  cfg: ProjectConfig,
  dryRun: boolean,
  routerConfig = ROUTER_CONFIG,
): Promise<Action[]> {
  // Cloudflare is read first: a named tunnel that cannot be set up stops the
  // run before Fly is touched.
  const tunnel: NamedTunnel | undefined =
    cfg.tunnel === 'named' ? await prepareTunnel(cfg, routerConfig) : undefined;
  const org = keychainRead('fly-org-slug').trim();
  // A new tunnel has a new token, so an existing secret holds the old one.
  const refresh = tunnel?.actions.some((a) => a.kind === 'create-tunnel')
    ? [TUNNEL_TOKEN_SECRET]
    : [];
  const actions = plan(cfg, await observe(cfg), refresh);
  if (tunnel) {
    console.log(
      tunnel.actions.length === 0
        ? `[deploy] tunnel ${tunnel.names.tunnel} and ${tunnel.names.origin}: nothing to do`
        : `[deploy] tunnel ${tunnel.names.tunnel}: ${tunnel.actions.map((a) => a.kind).join(', ')}`,
    );
  }
  console.log(
    actions.length === 0
      ? `[deploy] ${cfg.app} is up to date at ${cfg.imageLabel.slice(0, 9)}: nothing to do`
      : `[deploy] ${cfg.app}: ${actions.map(describe).join(', ')}`,
  );
  if (dryRun) return actions;
  const ctx: RunContext = { org };
  if (tunnel) {
    const id = await tunnel.apply();
    ctx.tunnelToken = () => tunnel.token(id);
  }
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
  });
  const routerConfig = arg(args, 'router-config') ?? ROUTER_CONFIG;
  const done = await deployProject(cfg, args.includes('--dry-run'), routerConfig);
  if (cfg.tunnel === 'named') {
    const names = routerNames(cfg, routerConfig);
    console.log(`[deploy] origin hostname: ${names.origin}`);
    console.log(
      `[deploy] to route ${names.publicHost}, add "${cfg.project}": "${names.origin}" to the router's projects and run bun run router:deploy`,
    );
  }
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
