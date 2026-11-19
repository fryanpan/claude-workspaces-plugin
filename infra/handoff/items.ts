/**
 * What CI hands to a holder, sealed (`seal.ts`), and the in-process sink a CI
 * script collects it in before writing one sealed file for the workflow to
 * upload as an artifact.
 *
 * Two holders, each named in the committed `recipients.json` by its public
 * key:
 *
 *   mac      prod's folder on the Mac. Gets the credentials CI made that a
 *            person or a Mac script needs later: a project's backup identity
 *            and bucket admin key, an Access service token's pair, and one
 *            Fly token per project app (`pull.ts` stores each).
 *   fly-org  the `fly-org` GitHub Environment, whose job opens it with
 *            HANDOFF_PRIVATE_KEY. Gets the Fly secrets only `cloudflare-prod`
 *            can read: a named tunnel's token and the Access settings
 *            (`provision-outputs.ts`).
 *
 * No value is printed: an item's description names its kind and target only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Envelope, open, seal } from './seal.ts';

export type Recipient = 'mac' | 'fly-org';

export type HandoffItem =
  /** A Keychain entry `mac-ops.ts keychainCreate` would have made on the Mac. */
  | { kind: 'keychain'; name: string; value: string }
  /** An Access service token's pair; `replace` for a rotated secret. */
  | { kind: 'service-token'; name: string; clientId: string; secret: string; replace: boolean }
  /** A Fly token for one app, for the Mac's own `fly` calls (`mac-ops.ts`). */
  | { kind: 'fly-app-token'; app: string; token: string; notAfter: number }
  /** Fly secrets for one app, set by the job that opens them. */
  | { kind: 'fly-secrets'; app: string; secrets: Record<string, string> };

export interface Sealed {
  recipient: Recipient;
  envelope: Envelope;
}

export const RECIPIENTS_FILE = join(import.meta.dir, 'recipients.json');

const KEYCHAIN_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const APP = /^cw-[a-z0-9][a-z0-9-]{0,62}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,99}$/;
const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;

/** The item, checked; throws naming the field, never a value. */
export function checkItem(raw: unknown): HandoffItem {
  const i = raw as Record<string, unknown>;
  const str = (k: string) => typeof i?.[k] === 'string' && (i[k] as string).length > 0;
  switch (i?.kind) {
    case 'keychain':
      if (str('name') && KEYCHAIN_NAME.test(i.name as string) && str('value'))
        return { kind: 'keychain', name: i.name as string, value: i.value as string };
      throw new Error('a keychain item needs a Keychain name and a value');
    case 'service-token':
      if (
        str('name') &&
        TOKEN_NAME.test(i.name as string) &&
        str('clientId') &&
        str('secret') &&
        typeof i.replace === 'boolean'
      )
        return {
          kind: 'service-token',
          name: i.name as string,
          clientId: i.clientId as string,
          secret: i.secret as string,
          replace: i.replace,
        };
      throw new Error('a service-token item needs a token name, a pair and replace');
    case 'fly-app-token':
      if (
        str('app') &&
        APP.test(i.app as string) &&
        str('token') &&
        Number.isSafeInteger(i.notAfter)
      )
        return {
          kind: 'fly-app-token',
          app: i.app as string,
          token: i.token as string,
          notAfter: i.notAfter as number,
        };
      throw new Error('a fly-app-token item needs a cw- app, a token and notAfter');
    case 'fly-secrets': {
      const secrets = i.secrets as Record<string, unknown> | undefined;
      const ok =
        str('app') &&
        APP.test(i.app as string) &&
        secrets !== null &&
        typeof secrets === 'object' &&
        Object.entries(secrets).every(
          ([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && v !== '' && !/\n/.test(v),
        );
      if (ok)
        return {
          kind: 'fly-secrets',
          app: i.app as string,
          secrets: secrets as Record<string, string>,
        };
      throw new Error('a fly-secrets item needs a cw- app and NAME=value secrets on one line each');
    }
    default:
      throw new Error('unknown handoff item');
  }
}

/** What an item is, for a log line: never a value. */
export function describeItem(i: HandoffItem): string {
  switch (i.kind) {
    case 'keychain':
      return `Keychain entry ${i.name}`;
    case 'service-token':
      return `service token "${i.name}"${i.replace ? ' (rotated)' : ''}`;
    case 'fly-app-token':
      return `Fly token for ${i.app}, until ${new Date(i.notAfter * 1000).toISOString().slice(0, 10)}`;
    case 'fly-secrets':
      return `Fly secrets ${Object.keys(i.secrets).join(', ')} for ${i.app}`;
  }
}

/** The committed public key for a holder. Throws until `handoff:keygen` has run for it. */
export function recipientKey(
  who: Recipient,
  read: () => string = () => readFileSync(RECIPIENTS_FILE, 'utf8'),
): string {
  const key = (JSON.parse(read()) as Record<string, unknown>)[who];
  if (typeof key !== 'string' || key === '') {
    throw new Error(
      `infra/handoff/recipients.json has no key for ${who}: run bun run handoff:keygen ${who} and commit it`,
    );
  }
  return key;
}

export function sealItems(who: Recipient, publicKey: string, items: HandoffItem[]): Sealed {
  return { recipient: who, envelope: seal(publicKey, JSON.stringify({ items })) };
}

/** Open a sealed file's text; every item is checked. */
export function openItems(
  privateKey: string,
  text: string,
): { recipient: Recipient; items: HandoffItem[] } {
  const s = JSON.parse(text) as Sealed;
  if (s.recipient !== 'mac' && s.recipient !== 'fly-org') throw new Error('no recipient');
  const body = JSON.parse(open(privateKey, s.envelope)) as { items?: unknown };
  if (!Array.isArray(body.items)) throw new Error('the envelope holds no items');
  return { recipient: s.recipient, items: body.items.map(checkItem) };
}

/**
 * In a GitHub Actions run (GITHUB_ACTIONS set), a function that registers a
 * value made at runtime as a secret, one `::add-mask::` line per line of it,
 * so the runner blanks it in every later log line. GitHub masks the secrets
 * it handed the job, not the ones a step made. Elsewhere, a no-op.
 */
export function actionsMask(
  env: Record<string, string | undefined>,
  out: (s: string) => void,
): (value: string) => void {
  if (!env.GITHUB_ACTIONS) return () => {};
  return (value) => {
    for (const line of value.split(/\r?\n/)) if (line.trim() !== '') out(`::add-mask::${line}\n`);
  };
}

/** The values an item carries, for masking. */
function secretValues(i: HandoffItem): string[] {
  switch (i.kind) {
    case 'keychain':
      return [i.value];
    case 'service-token':
      return [i.clientId, i.secret];
    case 'fly-app-token':
      return [i.token];
    case 'fly-secrets':
      return Object.values(i.secrets);
  }
}

/**
 * Items gathered during one CI run, sealed to one holder at the end. A CI
 * script adds to it; `flush` writes the file the workflow uploads, or
 * nothing when no item was added.
 */
export class HandoffSink {
  private readonly items: HandoffItem[] = [];
  private readonly mask: (value: string) => void;
  constructor(
    readonly who: Recipient,
    readonly outPath: string,
    env: Record<string, string | undefined> = process.env,
    out: (s: string) => void = (s) => process.stdout.write(s),
  ) {
    this.mask = actionsMask(env, out);
  }
  /** Masks each value first in a GitHub Actions run (`actionsMask`). */
  add(item: HandoffItem): void {
    const checked = checkItem(item);
    for (const v of secretValues(checked)) this.mask(v);
    this.items.push(checked);
  }
  get size(): number {
    return this.items.length;
  }
  /** What was added, for a log line: kinds and targets, never a value. */
  describe(): string[] {
    return this.items.map(describeItem);
  }
  flush(publicKey: string, write: (p: string, s: string) => void = writeFileSync): boolean {
    if (this.items.length === 0) return false;
    write(this.outPath, JSON.stringify(sealItems(this.who, publicKey, this.items)));
    return true;
  }
}

/** The sink CW_HANDOFF_OUT names, for the Mac; null outside a CI run that hands off. */
export function macSinkFromEnv(env: Record<string, string | undefined>): HandoffSink | null {
  const out = env.CW_HANDOFF_OUT?.trim();
  return out ? new HandoffSink('mac', out, env) : null;
}
