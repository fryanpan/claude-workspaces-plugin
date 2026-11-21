/**
 * Where `machine:deploy` and `signin:callbacks` get prod's Terraform outputs.
 *
 * A run that holds the state bucket's credential (AWS_ACCESS_KEY_ID and
 * AWS_SECRET_ACCESS_KEY, or a Keychain entry `credentials.ts` reads) reads
 * them from the state with `readOutputs`, as before. The Mac holds none since
 * its Cloudflare credentials were retired, so there they come from the newest
 * sealed wall read (`wall-read.yml`, `wall-read-pull.ts`), which carries the
 * same four outputs. That read is of prod only, and one older than
 * `MAX_AGE_MS` is refused, naming the dispatch that makes a new one.
 */
import {
  type CredentialSources,
  STATE_CARD_ID_ENTRY,
  STATE_CARD_SECRET_ENTRY,
  STATE_ENTRY,
} from '../cloudflare/credentials.ts';
import { type TfOutputs, readOutputs } from '../cloudflare/outputs.ts';
import type { TfEnv } from '../cloudflare/terraform.ts';
import { keychainHas, keychainRead } from './mac-ops.ts';
import {
  DISPATCH_HINT,
  MAX_AGE_MS,
  type Pulled,
  pullWallRead,
  realWallReadPullIo,
} from './wall-read-pull.ts';
import type { CloudflareRead } from './wall-read.ts';

const set = (v: string | undefined): boolean => typeof v === 'string' && v.trim() !== '';

/** Whether any source of the state credential is configured; reads no value. */
export function stateCredentialConfigured(src: CredentialSources): boolean {
  if (set(src.env.AWS_ACCESS_KEY_ID) && set(src.env.AWS_SECRET_ACCESS_KEY)) return true;
  return [STATE_ENTRY, STATE_CARD_ID_ENTRY, STATE_CARD_SECRET_ENTRY].some((e) =>
    src.keychainHas(e),
  );
}

export interface MacOutputsIo {
  sources: CredentialSources;
  state: (tfEnv: TfEnv) => TfOutputs;
  sealed: () => Pulled<CloudflareRead>;
  now: () => number;
  /** Where the line naming the read goes. */
  say: (line: string) => void;
}

/** The outputs from the state when a credential is configured, else from the sealed read. */
export function macOutputs(tfEnv: TfEnv, io: MacOutputsIo = realMacOutputsIo()): TfOutputs {
  if (stateCredentialConfigured(io.sources)) return io.state(tfEnv);
  if (tfEnv !== 'prod')
    throw new Error(
      `no state credential, and the sealed wall read holds prod's outputs only, not ${tfEnv}'s`,
    );
  const pulled = io.sealed();
  const age = io.now() - pulled.read.readAt;
  if (age > MAX_AGE_MS || age < -300_000) {
    const hours = Math.round(age / 3_600_000);
    throw new Error(
      `the newest sealed wall read (run ${pulled.runId}) is ${hours}h old, older than ${MAX_AGE_MS / 3_600_000}h or from the future: ${DISPATCH_HINT}`,
    );
  }
  io.say(
    `[outputs] prod's Terraform outputs from the sealed wall read, run ${pulled.runId}, ${Math.max(0, Math.round(age / 3_600_000))}h old`,
  );
  return pulled.read.outputs;
}

export function realMacOutputsIo(): MacOutputsIo {
  return {
    sources: { env: process.env, keychainHas, keychainRead },
    state: (tfEnv) => readOutputs(tfEnv),
    sealed: () => pullWallRead(realWallReadPullIo(), 'cloudflare'),
    now: Date.now,
    say: (line) => process.stderr.write(`${line}\n`),
  };
}
