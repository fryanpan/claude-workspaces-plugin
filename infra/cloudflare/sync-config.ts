#!/usr/bin/env bun
/**
 * `bun run cf:sync-config`: send prod's gitignored configs (router, Access,
 * share link) to CI through the keeper, on one passkey tap. An agent runs it;
 * Bryan taps.
 *
 *   1. Plan through the keeper (routine, as `cf:plan`), to learn which
 *      service tokens the account lacks, and refuse before anything is asked
 *      for if the Keychain already holds one's services.
 *   2. Ask the keeper for the sync (`keeper-cf-sync.ts`). Its approval page
 *      shows who each project's sign-in list gains or loses and which tokens
 *      it makes; the tap makes them, writes the CF_*_CONFIG repository
 *      secrets, and starts `cloudflare.yml` on main, whose apply job applies.
 *   3. Put each new token's client id and secret straight into the Keychain
 *      (`service-tokens.ts`), even when a later step failed: Cloudflare
 *      returns a secret once. Never printed, never written to a file.
 *
 * Sends what `cf:plan` sends (`keeper-wrapper.ts` `keeperInput`): the configs
 * and the state bucket's credential. Reads no Cloudflare or GitHub token.
 */
import {
  announceToBoard,
  boardUrlFromEnv,
} from '../../packages/server/src/keeper/keeper-announce.ts';
import { keeperHeld, keeperTerraform } from '../../packages/server/src/keeper/keeper-client.ts';
import type {
  CloudflareResult,
  FlyResult,
} from '../../packages/server/src/keeper/keeper-requests.ts';
import { keychainHas, keychainRead } from '../project-machine/mac-ops.ts';
import { type KeeperInputIo, failed, keeperInput, reportOf } from './keeper-wrapper.ts';
import { configReader } from './run.ts';
import {
  type TokenServices,
  keychainHasService,
  storeTokenInKeychain,
  tokenServices,
} from './service-tokens.ts';

export interface SyncIo extends KeeperInputIo {
  keychainHasService: (service: string) => boolean;
  storeToken: (services: TokenServices, clientId: string, secret: string) => void;
  /** A routine plan through the keeper. */
  plan: (input: string) => Promise<FlyResult>;
  /** The held sync; resolves once the owner approved or denied. */
  sync: (input: string) => Promise<CloudflareResult>;
  out: (s: string) => void;
  err: (s: string) => void;
}

interface Minted {
  name?: unknown;
  id?: unknown;
  clientId?: unknown;
  secret?: unknown;
}

interface SyncAnswer {
  error?: string;
  written?: string[];
  dispatched?: string;
  minted?: Minted[];
}

/** Put each new pair in the Keychain. False, naming what was lost, when one cannot be. */
function storeMinted(io: SyncIo, minted: Minted[]): boolean {
  let ok = true;
  for (const t of minted) {
    const name = typeof t.name === 'string' ? t.name : '';
    const services = tokenServices(name || 'unnamed');
    try {
      if (typeof t.clientId !== 'string' || typeof t.secret !== 'string') throw new Error();
      io.storeToken(services, t.clientId, t.secret);
      io.out(`Made service token "${name}"; its pair is in the Keychain.\n`);
    } catch {
      // Never the caught message: it was raised next to the secret.
      io.err(
        `Made service token "${name}"${typeof t.id === 'string' ? ` (${t.id})` : ''} but could not store its pair in ${services.secret}. Its secret is lost: run bun run cf:rotate-token "${name}" to give it a new one.\n`,
      );
      ok = false;
    }
  }
  return ok;
}

/** Exit code: 0 once CI was started with the new configs, 1 otherwise. */
export async function syncConfig(io: SyncIo): Promise<number> {
  try {
    const input = keeperInput('prod', io);
    const planned = await io.plan(input);
    const plan = reportOf(planned);
    if (planned.status !== 0 || !plan?.ok) return failed(io, planned, plan);
    const refusals: string[] = [];
    const seen = new Map<string, string>();
    for (const name of Object.values(plan.missing ?? {})) {
      const s = tokenServices(name);
      const prior = seen.get(s.secret);
      if (prior) refusals.push(`"${prior}" and "${name}" would share ${s.secret}`);
      seen.set(s.secret, name);
      for (const x of [s.clientId, s.secret]) {
        if (io.keychainHasService(x)) refusals.push(`the Keychain already holds ${x}`);
      }
    }
    if (refusals.length > 0) {
      for (const t of refusals) io.err(`  - ${t}\n`);
      io.err('Refused before anything was asked of the keeper; nothing was changed.\n');
      return 1;
    }
    const r = await io.sync(input);
    let answer: SyncAnswer = {};
    try {
      answer = JSON.parse(r.body) as SyncAnswer;
    } catch {}
    const stored = storeMinted(io, Array.isArray(answer.minted) ? answer.minted : []);
    if (r.status !== 200) {
      io.err(`${answer.error ?? `the keeper answered ${r.status}`}\n`);
      return 1;
    }
    io.out(`Wrote ${(answer.written ?? []).join(', ')}.\n`);
    io.out(
      `Started ${answer.dispatched ?? 'cloudflare.yml'}; its apply job applies the configs (gh run list --workflow cloudflare.yml).\n`,
    );
    return stored ? 0 : 1;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  const origin = process.env.CW_KEEPER_URL?.trim() ?? '';
  if (!origin) {
    process.stderr.write(
      'cf:sync-config needs the keeper: CW_KEEPER_URL is not set (docs/process/keeper.md).\n',
    );
    process.exit(2);
  }
  const requester = process.env.FEEDBACK_AGENT_NAME?.trim() || 'cf:sync-config';
  const opts = {
    requester,
    // A tap can take a while to reach; the run that follows makes tokens and writes secrets.
    waitMs: 30 * 60_000,
    announce: announceToBoard(boardUrlFromEnv(), requester),
    onHeld: (held: { summary: string; approveUrl: string }) => {
      process.stderr.write(`[keeper] ${held.summary} waits for Bryan's passkey\n`);
      process.stderr.write(`[keeper] approve at ${held.approveUrl}\n`);
    },
  };
  const code = await syncConfig({
    read: configReader(process.env),
    env: process.env,
    keychainHas,
    keychainRead,
    keychainHasService: (s) => keychainHasService(s),
    storeToken: storeTokenInKeychain,
    plan: (input) => keeperTerraform(origin, 'plan', 'prod', input, opts),
    sync: (input) => keeperHeld(origin, '/v1/cf-sync', { input }, opts),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  process.exit(code);
}
