/**
 * The transcript store's decisions in `machine:deploy`, with no I/O
 * (`deploy-plan.ts` calls them; `deploy-store.ts` acts on them).
 */
import type { Observed } from './deploy-plan.ts';

/** The app's secrets for its store writer, set together in the run that mints it. */
export const STORE_SECRETS = [
  'STORE_S3_ENDPOINT',
  'STORE_S3_BUCKET',
  'STORE_S3_ACCESS_KEY_ID',
  'STORE_S3_SECRET_ACCESS_KEY',
  'STORE_KEYS',
] as const;

/** The secret whose presence says the app has its writer. */
export const STORE_WRITER_SECRET = 'STORE_S3_ACCESS_KEY_ID';

/** The machine's two hosts: the server's sessions and logs, and the lead's sessions. */
export const storeHosts = (app: string): [string, string] => [app, `${app}_lead`];

/** What a machine's store writer may do: put under its own two hosts. */
export function storeWriterPolicy(bucket: string, app: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:PutObject'],
        Resource: storeHosts(app).map((h) => `arn:aws:s3:::${bucket}/${h}/*`),
      },
    ],
  });
}

/** What `observe` reports about the store. */
export interface StoreObserved {
  /** The admin credential and the public keys are both found. */
  ready: boolean;
  /** This run may make things (fly-provision.yml: env secrets and a handoff sink). */
  canMake: boolean;
}

/** The store's actions for this run, in order; empty off CI or once the writer exists. */
export function storeActions(
  obs: Pick<Observed, 'secrets' | 'store'>,
): ({ kind: 'setup-store' } | { kind: 'make-store-writer' })[] {
  const s = obs.store;
  if (!s?.canMake || obs.secrets.has(STORE_WRITER_SECRET)) return [];
  return [...(s.ready ? [] : [{ kind: 'setup-store' as const }]), { kind: 'make-store-writer' }];
}

/** The store secrets to set this run: all of them, only beside a new writer. */
export function storeSecretNames(obs: Pick<Observed, 'secrets' | 'store'>): string[] {
  return storeActions(obs).length > 0 ? [...STORE_SECRETS] : [];
}
