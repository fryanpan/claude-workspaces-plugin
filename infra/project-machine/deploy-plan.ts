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
  /** Keychain entries, under the `claude-workspaces-secret.` prefix. */
  keychain: { identity: string; bucketAdmin: string; writer: string };
}

export interface ConfigInput {
  project: string;
  imageLabel: string;
  region?: string;
  volumeGb?: number;
  vmSize?: string;
  vmMemoryMb?: number;
  tunnel?: TunnelMode;
}

const PROJECT_NAME = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

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
    },
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
  | { kind: 'deploy' }
  | { kind: 'start-machine'; id: string };

/** The Fly secrets the machine needs, by tunnel mode. */
export function requiredSecrets(tunnel: TunnelMode): string[] {
  return [
    'BACKUP_RECIPIENT',
    'BACKUP_S3_ENDPOINT',
    'BACKUP_S3_BUCKET',
    'BACKUP_S3_ACCESS_KEY_ID',
    'BACKUP_S3_SECRET_ACCESS_KEY',
    tunnel === 'named' ? 'CLOUDFLARE_TUNNEL_TOKEN' : 'CW_TUNNEL_MODE',
  ];
}

export function plan(cfg: ProjectConfig, obs: Observed): Action[] {
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
  const names = requiredSecrets(cfg.tunnel).filter((n) => !obs.secrets.has(n));
  if (names.length > 0) actions.push({ kind: 'set-secrets', names });
  const current = obs.machines.filter((m) => m.state !== 'destroyed');
  if (
    current.length === 0 ||
    names.length > 0 ||
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
