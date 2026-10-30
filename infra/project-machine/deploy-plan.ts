/**
 * The decisions `deploy.ts` makes, with no I/O, so they can be tested
 * without a Fly account.
 *
 * A run reads what exists (`Observed`), compares it with what one project
 * needs (`ProjectConfig`), and does only the missing steps (`plan`). A run
 * over a project that is already complete plans nothing, which is what makes
 * the script safe to run twice.
 */
import { createHash } from 'node:crypto';

export type TunnelMode = 'quick' | 'named';

export interface ProjectConfig {
  project: string;
  app: string;
  /** The app's private network. One per project, so no two projects share one. */
  network: string;
  region: string;
  volumeName: string;
  volumeGb: number;
  vmSize: string;
  vmMemoryMb: number;
  bucket: string;
  tunnel: TunnelMode;
  /** The git commit the image is built from; it is also the image label. */
  imageLabel: string;
  /**
   * Keychain entries, under the `claude-workspaces-secret.` prefix. The
   * script makes the first three. `orgKey` is the org's own Anthropic key,
   * and `leadToken` the lead agent's Claude Code sign-in; only a person can
   * provide either, and the machine gets each only when it exists.
   */
  keychain: {
    identity: string;
    bucketAdmin: string;
    writer: string;
    orgKey: string;
    leadToken: string;
    /** The project repo's deploy key, when one was named (`--github-deploy-key`). */
    deployKey?: string;
  };
  /** The board the lead leads (`--lead-board`). No board, no lead. */
  leadBoard?: string;
  /** Lead secrets to set again even though they exist: the ones this run named. */
  leadRefresh: string[];
}

export interface ConfigInput {
  project: string;
  imageLabel: string;
  region?: string;
  volumeGb?: number;
  vmSize?: string;
  vmMemoryMb?: number;
  tunnel?: TunnelMode;
  /** The `claudeAccounts` label whose Claude Code token the lead signs in with. */
  claudeAccount?: string;
  /** The Keychain entry holding the project repo's deploy key (OpenSSH private key). */
  githubDeployKey?: string;
  /** The board the lead leads. */
  leadBoard?: string;
  /** Set every lead secret again from its source (`--refresh-lead`). */
  refreshLead?: boolean;
}

const PROJECT_NAME = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const ACCOUNT_LABEL = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEYCHAIN_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The Keychain entry the walled lead on the Mac signs in from
 * (`scripts/lead-sandbox-token.ts`, `TOKEN_SERVICE`): the token from
 * `claude setup-token`, BASE64. A labelled account's is `<entry>.<label>`.
 */
export const LEAD_TOKEN_ENTRY = 'claude-lead-oauth-token';

/** The Fly secret the lead's Claude Code signs in with (entrypoint.sh, lead.sh). */
export const LEAD_TOKEN_SECRET = 'CLAUDE_CODE_OAUTH_TOKEN';
/** The board the lead leads; its socket is the lead's one way to the server. */
export const LEAD_BOARD_SECRET = 'CW_LEAD_BOARD';
/** The project repo's deploy key, BASE64, which lead.sh writes to a file of the lead's. */
export const LEAD_DEPLOY_KEY_SECRET = 'CW_LEAD_GITHUB_DEPLOY_KEY';
export const LEAD_SECRETS = [LEAD_TOKEN_SECRET, LEAD_BOARD_SECRET, LEAD_DEPLOY_KEY_SECRET];
/**
 * A machine with a lead needs this much: the lead's cgroup is capped at
 * 1280 MB (entrypoint.sh) and the server keeps the rest.
 */
export const LEAD_MIN_MEMORY_MB = 2048;

export function projectConfig(input: ConfigInput): ProjectConfig {
  const { project } = input;
  if (!PROJECT_NAME.test(project)) {
    throw new Error(
      `project name "${project}" must be 3-40 characters of a-z, 0-9 and -, starting with a letter`,
    );
  }
  if (!GIT_SHA.test(input.imageLabel)) {
    throw new Error(`image label must be a full git commit sha, got "${input.imageLabel}"`);
  }
  const volumeGb = input.volumeGb ?? 1;
  const vmMemoryMb = input.vmMemoryMb ?? 512;
  if (!Number.isInteger(volumeGb) || volumeGb < 1 || volumeGb > 50) {
    throw new Error(`volume size must be 1-50 GB, got ${volumeGb}`);
  }
  if (!Number.isInteger(vmMemoryMb) || vmMemoryMb < 256 || vmMemoryMb > 4096) {
    throw new Error(`memory must be 256-4096 MB, got ${vmMemoryMb}`);
  }
  if (input.tunnel !== undefined && input.tunnel !== 'quick' && input.tunnel !== 'named') {
    throw new Error(`tunnel must be quick or named, got "${input.tunnel}"`);
  }
  if (input.claudeAccount !== undefined && !ACCOUNT_LABEL.test(input.claudeAccount)) {
    throw new Error(`claude account must be a-z, 0-9 and -, got "${input.claudeAccount}"`);
  }
  if (input.githubDeployKey !== undefined && !KEYCHAIN_ENTRY.test(input.githubDeployKey)) {
    throw new Error(
      `deploy key entry must be A-Z, a-z, 0-9, ., _ and -, got "${input.githubDeployKey}"`,
    );
  }
  if (input.leadBoard !== undefined && !BOARD_ID.test(input.leadBoard)) {
    throw new Error(
      `lead board must be a board id (A-Z, a-z, 0-9, _ and -), got "${input.leadBoard}"`,
    );
  }
  // A secret this run names a source for is set again: that is the point of
  // naming it.
  const leadRefresh = input.refreshLead
    ? [...LEAD_SECRETS]
    : [
        ...(input.claudeAccount !== undefined ? [LEAD_TOKEN_SECRET] : []),
        ...(input.leadBoard !== undefined ? [LEAD_BOARD_SECRET] : []),
        ...(input.githubDeployKey !== undefined ? [LEAD_DEPLOY_KEY_SECRET] : []),
      ];
  const app = `cw-${project}`;
  return {
    project,
    app,
    network: app,
    region: input.region ?? 'sjc',
    volumeName: 'cw_data',
    volumeGb,
    vmSize: input.vmSize ?? 'shared-cpu-1x',
    vmMemoryMb,
    bucket: `${app}-backups`,
    tunnel: input.tunnel ?? 'quick',
    imageLabel: input.imageLabel,
    keychain: {
      identity: `${app}-backup-identity`,
      bucketAdmin: `${app}-bucket-admin`,
      writer: `${app}-backup-writer`,
      orgKey: `${app}-anthropic-api-key`,
      leadToken: input.claudeAccount
        ? `${LEAD_TOKEN_ENTRY}.${input.claudeAccount}`
        : LEAD_TOKEN_ENTRY,
      ...(input.githubDeployKey !== undefined ? { deployKey: input.githubDeployKey } : {}),
    },
    ...(input.leadBoard !== undefined ? { leadBoard: input.leadBoard } : {}),
    leadRefresh,
  };
}

export interface ObservedMachine {
  id: string;
  state: string;
  /** The image tag the machine runs, or '' when Fly does not say. */
  imageTag: string;
  memoryMb: number;
}

export interface Observed {
  app: boolean;
  /** Volumes of the configured name in the configured region, not destroyed. */
  volumes: number;
  /** Names of Keychain entries that exist (values are never read here). */
  keychain: ReadonlySet<string>;
  lifecycle: boolean;
  /** Names of the app's Fly secrets. */
  secrets: ReadonlySet<string>;
  machines: readonly ObservedMachine[];
}

export type Action =
  | { kind: 'create-app' }
  | { kind: 'create-volume' }
  | { kind: 'make-backup-key' }
  | { kind: 'create-bucket' }
  | { kind: 'make-writer-key' }
  | { kind: 'set-lifecycle' }
  | { kind: 'set-secrets'; names: string[] }
  | { kind: 'unset-secrets'; names: string[] }
  | { kind: 'deploy' }
  | { kind: 'start-machine'; id: string };

/** The secret a project server spends Claude calls from (project-profile.ts). */
export const ORG_KEY_SECRET = 'CW_ORG_ANTHROPIC_API_KEY';

/**
 * The Fly secrets the machine needs, by tunnel mode, plus the org's Anthropic
 * key when one was provided (without it the server refuses every Claude
 * call) and the lead's secrets (`leadSecrets`).
 */
export function requiredSecrets(
  tunnel: TunnelMode,
  orgKey = false,
  lead: readonly string[] = [],
): string[] {
  return [
    ...(orgKey ? [ORG_KEY_SECRET] : []),
    ...lead,
    'BACKUP_RECIPIENT',
    'BACKUP_S3_ENDPOINT',
    'BACKUP_S3_BUCKET',
    'BACKUP_S3_ACCESS_KEY_ID',
    'BACKUP_S3_SECRET_ACCESS_KEY',
    tunnel === 'named' ? 'CLOUDFLARE_TUNNEL_TOKEN' : 'CW_TUNNEL_MODE',
  ];
}

/**
 * The lead's secrets the machine needs. A machine has a lead only when it has
 * a board to lead, named now or set before: a project with no board gets no
 * sign-in, even though the Mac's walled lead keeps one in the Keychain.
 */
export function leadSecrets(cfg: ProjectConfig, obs: Observed): string[] {
  if (cfg.leadBoard === undefined && !obs.secrets.has(LEAD_BOARD_SECRET)) return [];
  const { deployKey } = cfg.keychain;
  return [
    ...(obs.keychain.has(cfg.keychain.leadToken) ? [LEAD_TOKEN_SECRET] : []),
    ...(cfg.leadBoard !== undefined ? [LEAD_BOARD_SECRET] : []),
    ...(deployKey !== undefined && obs.keychain.has(deployKey) ? [LEAD_DEPLOY_KEY_SECRET] : []),
  ];
}

/** Whether a lead agent will run on the machine after this run. */
export function leadRuns(cfg: ProjectConfig, obs: Observed): boolean {
  return (
    leadSecrets(cfg, obs).includes(LEAD_TOKEN_SECRET) ||
    ((cfg.leadBoard !== undefined || obs.secrets.has(LEAD_BOARD_SECRET)) &&
      obs.secrets.has(LEAD_TOKEN_SECRET))
  );
}

/** Why the machine is too small for its lead, or null. */
export function leadMemoryError(cfg: ProjectConfig, obs: Observed): string | null {
  if (!leadRuns(cfg, obs) || cfg.vmMemoryMb >= LEAD_MIN_MEMORY_MB) return null;
  return `a lead agent runs on ${cfg.app}, which needs --memory ${LEAD_MIN_MEMORY_MB} or more (got ${cfg.vmMemoryMb})`;
}

/**
 * `refresh` names secrets to set even though they exist: the tunnel token,
 * when this run creates the tunnel it belongs to. `settings` names the
 * per-project settings this run found a source for (`settings.ts`).
 */
export function plan(
  cfg: ProjectConfig,
  obs: Observed,
  refresh: readonly string[] = [],
  settings: readonly string[] = [],
): Action[] {
  const actions: Action[] = [];
  if (!obs.app) actions.push({ kind: 'create-app' });
  if (obs.volumes === 0) actions.push({ kind: 'create-volume' });
  if (!obs.keychain.has(cfg.keychain.identity)) actions.push({ kind: 'make-backup-key' });
  const bucketIsNew = !obs.keychain.has(cfg.keychain.bucketAdmin);
  if (bucketIsNew) actions.push({ kind: 'create-bucket' });
  if (!obs.keychain.has(cfg.keychain.writer)) actions.push({ kind: 'make-writer-key' });
  if (bucketIsNew || !obs.lifecycle) actions.push({ kind: 'set-lifecycle' });
  // A secret that exists is left alone: its value came from the Keychain
  // entry it is named after, and that entry is only ever made once.
  const names = [
    ...requiredSecrets(cfg.tunnel, obs.keychain.has(cfg.keychain.orgKey), leadSecrets(cfg, obs)),
    ...settings,
  ].filter((n) => !obs.secrets.has(n) || refresh.includes(n) || cfg.leadRefresh.includes(n));
  if (names.length > 0) actions.push({ kind: 'set-secrets', names });
  // A machine that ran a quick tunnel keeps running one while this is set.
  const unset =
    cfg.tunnel === 'named' && obs.secrets.has('CW_TUNNEL_MODE') ? ['CW_TUNNEL_MODE'] : [];
  if (unset.length > 0) actions.push({ kind: 'unset-secrets', names: unset });
  const current = obs.machines.filter((m) => m.state !== 'destroyed');
  if (
    current.length === 0 ||
    names.length > 0 ||
    unset.length > 0 ||
    current.some((m) => m.imageTag !== cfg.imageLabel || m.memoryMb !== cfg.vmMemoryMb)
  ) {
    actions.push({ kind: 'deploy' });
  } else {
    for (const m of current) {
      if (m.state !== 'started') actions.push({ kind: 'start-machine', id: m.id });
    }
  }
  return actions;
}

/**
 * The committed fly.toml with this project's app, region and size written
 * in. `fly deploy` lets the file's [[vm]] block win over its --vm-* flags,
 * so the size has to be in the file the deploy reads.
 */
export function renderFlyToml(base: string, cfg: ProjectConfig): string {
  const vm = base.search(/^\[\[vm\]\]/m);
  if (vm < 0) throw new Error('fly.toml has no [[vm]] block');
  return `${base
    .slice(0, vm)
    .replace(/^app = .*$/m, `app = "${cfg.app}"`)
    .replace(
      /^primary_region = .*$/m,
      `primary_region = "${cfg.region}"`,
    )}[[vm]]\n  size = "${cfg.vmSize}"\n  memory = "${cfg.vmMemoryMb}mb"\n`;
}

/** The one policy the machine's bucket credential holds: put objects under the prefix. */
export function writeOnlyPolicy(bucket: string, prefix: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:PutObject'],
        Resource: [`arn:aws:s3:::${bucket}/${prefix}*`],
      },
    ],
  });
}

export interface BucketCredential {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Read the credential `fly storage create` prints. It prints each value on
 * a `NAME: value` line; anything else on the screen is ignored.
 */
export function parseStorageCreate(output: string): BucketCredential {
  const values = new Map<string, string>();
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*(AWS_[A-Z0-9_]+|BUCKET_NAME)\s*[:=]\s*(\S+)\s*$/);
    if (m?.[1] && m[2]) values.set(m[1], m[2]);
  }
  const endpoint = values.get('AWS_ENDPOINT_URL_S3');
  const accessKeyId = values.get('AWS_ACCESS_KEY_ID');
  const secretAccessKey = values.get('AWS_SECRET_ACCESS_KEY');
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    const seen = [...values.keys()].join(', ') || 'none';
    throw new Error(`fly storage create printed no complete credential (names seen: ${seen})`);
  }
  return { endpoint, accessKeyId, secretAccessKey };
}

/** The quick tunnel's address, from the machine's logs; the newest wins. */
export function quickTunnelUrl(logs: string): string | null {
  const all = logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  return all?.at(-1) ?? null;
}

/** The newest snapshot key. Keys start with a UTC stamp after the host. */
export function newestSnapshot(keys: readonly string[]): string | null {
  const snaps = keys.filter((k) => k.endsWith('.cwsnap'));
  if (snaps.length === 0) return null;
  const stamp = (k: string) => k.split('/').at(-1) ?? '';
  return snaps.reduce((a, b) => (stamp(b) > stamp(a) ? b : a));
}

export interface DocFingerprint {
  workspaceId: string;
  docId: string;
  text: string;
}

/** One hash over every doc's text, independent of the order they were read in. */
export function fingerprint(docs: readonly DocFingerprint[]): { count: number; sha256: string } {
  const lines = docs
    .map(
      (d) => `${d.workspaceId}\t${d.docId}\t${createHash('sha256').update(d.text).digest('hex')}`,
    )
    .sort();
  return {
    count: docs.length,
    sha256: createHash('sha256').update(lines.join('\n')).digest('hex'),
  };
}

export interface LogFingerprint {
  files: number;
  lines: number;
  sha256: string;
  /** Lines per file, so a later read can hash the same prefix. */
  linesByFile: Record<string, number>;
}

/**
 * One hash over append-only logs (events, agent notes, transcripts). A
 * running server may append after a backup, so a restore is compared on the
 * prefix the backup held: pass the earlier read's `linesByFile` as `limits`
 * and each file is cut to that many lines first. A file in `limits` that is
 * missing hashes as empty, so a lost log changes the hash.
 */
export function logFingerprint(
  files: readonly { path: string; text: string }[],
  limits?: Record<string, number>,
): LogFingerprint {
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  const paths = limits ? Object.keys(limits) : [...byPath.keys()];
  const linesByFile: Record<string, number> = {};
  const parts: string[] = [];
  for (const path of paths.sort()) {
    const all = (byPath.get(path) ?? '').split('\n').filter((l) => l.length > 0);
    const kept = limits ? all.slice(0, limits[path]) : all;
    linesByFile[path] = kept.length;
    parts.push(`${path}\t${createHash('sha256').update(kept.join('\n')).digest('hex')}`);
  }
  return {
    files: paths.length,
    lines: Object.values(linesByFile).reduce((a, b) => a + b, 0),
    sha256: createHash('sha256').update(parts.join('\n')).digest('hex'),
    linesByFile,
  };
}

export interface DrillPrint {
  count: number;
  sha256: string;
  ydocs: number;
  events: LogFingerprint;
  notes: LogFingerprint;
  transcripts: LogFingerprint;
}

export const DRILL_LOGS = ['events', 'notes', 'transcripts'] as const;

/** The limits a fingerprint after the restore is cut to: what the backup held. */
export function drillLimits(before: DrillPrint): Record<string, Record<string, number>> {
  return Object.fromEntries(DRILL_LOGS.map((k) => [k, before[k].linesByFile]));
}

/**
 * One line per thing the drill checks, and whether all of them held. Each
 * must have been present before the backup: a drill over an empty log
 * proves nothing about it.
 */
export function judgeDrill(
  before: DrillPrint,
  after: DrillPrint,
): { ok: boolean; lines: string[] } {
  const rows = [
    {
      what: 'docs',
      b: before.count,
      a: after.count,
      same: before.sha256 === after.sha256,
      sha: before.sha256,
    },
    ...DRILL_LOGS.map((k) => ({
      what: k,
      b: before[k].lines,
      a: after[k].lines,
      same: before[k].sha256 === after[k].sha256,
      sha: before[k].sha256,
    })),
  ];
  const lines = rows.map(
    (r) =>
      `${r.b > 0 && r.a === r.b && r.same ? 'PASS' : 'FAIL'} ${r.what}: ${r.b} -> ${r.a}, sha256 ${r.sha.slice(0, 12)} ${r.same ? 'matches' : 'DIFFERS'}`,
  );
  return { ok: rows.every((r) => r.b > 0 && r.a === r.b && r.same), lines };
}
