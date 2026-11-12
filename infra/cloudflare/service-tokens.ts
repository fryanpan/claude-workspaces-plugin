/**
 * Making the Access service tokens the config names and the account lacks,
 * in the keeper's run for `cf:sync-config` (`keeper-run.ts tokens`), and
 * storing a token's pair in Bryan's Keychain (`sync-config.ts`,
 * `rotate-token.ts`). Terraform owns every token
 * (`modules/access`), but it does not make one: the wrapper does, here, and
 * the apply that follows adopts it by id (`service_token_ids`, imported in
 * each root). That is what keeps a token's secret out of the state. The
 * provider stores `client_secret` for a token it creates, and every same-repo
 * pull request's plan can read the state; an imported token has no secret in
 * it, because Cloudflare returns the secret only to the call that made it.
 *
 * The secret goes from that one answer straight into the Keychain, beside the
 * client id, under services named from the token's name
 * (`cw-<name>-access-secret`, `cw-<name>-access-client-id`): the spelling
 * `CW_ACCESS_SECRET_SERVICE` and the relay configs already use
 * (`docs/process/project-machine.md`). Stored plain, not base64, under the
 * account `claude-workspaces`, so `readKeychainSecret`
 * (`packages/plugin/hooks/lib/access-headers.ts`) reads it as it is. Neither
 * value is printed, logged, written to a file, or put in an argument: the
 * Keychain line goes to `security -i` on stdin.
 *
 * Tested by `packages/server/test/cloudflare-tf-service-tokens.test.ts` and
 * `cloudflare-tf-keeper-wrapper.test.ts` (the `cf:sync-config` side).
 */
import { spawnSync } from 'node:child_process';
import type { CloudflareApi } from '../project-machine/cloudflare.ts';

export interface TokenServices {
  clientId: string;
  secret: string;
}

/** The Keychain services a token's client id and secret are stored under. */
export function tokenServices(cloudflareName: string): TokenServices {
  const slug = cloudflareName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug)
    throw new Error(`the service token name "${cloudflareName}" names no Keychain service`);
  return { clientId: `cw-${slug}-access-client-id`, secret: `cw-${slug}-access-secret` };
}

const CLIENT_ID = /^[A-Za-z0-9._-]{1,256}\.access$/;
const SECRET = /^[A-Za-z0-9]{16,256}$/;
const SERVICE = /^[A-Za-z0-9._-]{1,128}$/;
const ACCOUNT = 'claude-workspaces';

export interface MintIo {
  /** Whether the Keychain holds anything under this service. */
  keychainHasService: (service: string) => boolean;
  /** Store both values; throws, naming a service and never a value, when it cannot. */
  storeToken: (services: TokenServices, clientId: string, secret: string) => void;
  /** Ask the person; true only for "yes". */
  confirm: (question: string) => boolean;
  out: (s: string) => void;
  err: (s: string) => void;
}

export type Minted = { ok: true; ids: Record<string, string> } | { ok: false };

interface Created {
  id?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
}

/**
 * Make each token in `missing` (config name -> name in Cloudflare), store its
 * pair, and return the new ids keyed by config name. Refuses, before any
 * write, a Keychain service that is already taken or that two names share,
 * and anything but "yes" to the question it asks first.
 */
export async function mintServiceTokens(
  api: CloudflareApi,
  accountId: string,
  missing: Record<string, string>,
  io: MintIo,
): Promise<Minted> {
  const plan = Object.entries(missing).map(([key, name]) => ({
    key,
    name,
    services: tokenServices(name),
  }));
  const refusals: string[] = [];
  const seen = new Map<string, string>();
  for (const { name, services } of plan) {
    const prior = seen.get(services.secret);
    if (prior) refusals.push(`"${prior}" and "${name}" would share ${services.secret}`);
    seen.set(services.secret, name);
    for (const s of [services.clientId, services.secret]) {
      if (io.keychainHasService(s)) refusals.push(`the Keychain already holds ${s}`);
    }
  }
  if (refusals.length > 0) {
    for (const r of refusals) io.err(`  - ${r}\n`);
    io.err('Refused before any service token was made; nothing was changed.\n');
    return { ok: false };
  }
  for (const { name, services } of plan) {
    io.out(
      `Service token "${name}" does not exist. Apply makes it and stores its client id in ${services.clientId} and its secret in ${services.secret}.\n`,
    );
  }
  if (!io.confirm(`Make ${plan.length} service token(s) now?`)) {
    io.err('Not confirmed; nothing was changed.\n');
    return { ok: false };
  }
  const ids: Record<string, string> = {};
  for (const { key, name, services } of plan) {
    const made = await api<Created>('POST', `/accounts/${accountId}/access/service_tokens`, {
      name,
    });
    const id = typeof made.id === 'string' ? made.id : '';
    try {
      if (!id) throw new Error('no id');
      if (typeof made.client_id !== 'string' || typeof made.client_secret !== 'string') {
        throw new Error('no pair');
      }
      io.storeToken(services, made.client_id, made.client_secret);
    } catch {
      // Never the caught message: it was raised next to the secret.
      io.err(
        `Made service token "${name}"${id ? ` (${id})` : ''} but could not store its pair in ${services.secret}. Its secret is lost: rotate it in the dashboard, then add the pair to the Keychain by hand.\n`,
      );
      return { ok: false };
    }
    ids[key] = id;
    io.out(`Made service token "${name}"; its pair is in the Keychain.\n`);
  }
  return { ok: true, ids };
}

/** Whether the Keychain holds an item under `service`, any account. */
export function keychainHasService(service: string, bin = 'security'): boolean {
  if (!SERVICE.test(service)) return false;
  const r = spawnSync(bin, ['find-generic-password', '-s', service], {
    stdio: 'ignore',
    env: process.env,
  });
  return r.status === 0;
}

/**
 * Add one item, refusing to replace an existing one unless `replace` (`-U`,
 * for a rotated secret). The value is checked against the shape Cloudflare
 * gives it, so it cannot break out of the quoted `-w` argument of the line
 * `security -i` reads on stdin.
 */
export function keychainAdd(
  service: string,
  value: string,
  kind: 'id' | 'secret',
  bin = 'security',
  replace = false,
): void {
  if (!SERVICE.test(service)) throw new Error(`${service} is not a Keychain service name`);
  if (!(kind === 'id' ? CLIENT_ID : SECRET).test(value)) {
    throw new Error(
      `the value for ${service} is not shaped like an Access ${kind === 'id' ? 'client id' : 'secret'}`,
    );
  }
  if (!replace && keychainHasService(service, bin)) {
    throw new Error(`the Keychain already holds ${service}`);
  }
  const r = spawnSync(bin, ['-i'], {
    input: `add-generic-password${replace ? ' -U' : ''} -a ${ACCOUNT} -s ${service} -w "${value}"\n`,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: process.env,
  });
  if (r.status !== 0 || !keychainHasService(service, bin)) {
    throw new Error(`could not store ${service} in the Keychain`);
  }
}

/** The real store: the client id, then the secret. */
export function storeTokenInKeychain(
  services: TokenServices,
  clientId: string,
  secret: string,
): void {
  keychainAdd(services.clientId, clientId, 'id');
  keychainAdd(services.secret, secret, 'secret');
}

/** A rotated pair over the old one: same services, `-U`. */
export function replaceTokenInKeychain(
  services: TokenServices,
  clientId: string,
  secret: string,
): void {
  keychainAdd(services.clientId, clientId, 'id', 'security', true);
  keychainAdd(services.secret, secret, 'secret', 'security', true);
}
