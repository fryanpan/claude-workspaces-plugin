/**
 * `bun run cf:plan` and `cf:apply` on the Mac once the keeper holds the
 * Cloudflare token (`CW_KEEPER_URL` set, no `--ci`). The keeper runs
 * terraform from its own release with its own token
 * (`packages/server/src/keeper/keeper-terraform.ts`, `keeper-run.ts`); this
 * side sends only the configs and the state bucket's credential, which are
 * Bryan's and already readable here, and reads no Cloudflare token at all.
 *
 *   plan    runs at once and prints the plan.
 *   apply   prints the plan, then waits for Bryan's passkey on the keeper's
 *           approval page, which shows that same plan; the tap applies it.
 *           When the account lacks a service token the config names, the
 *           first tap makes exactly those tokens and this side puts each pair
 *           straight into the Keychain (`service-tokens.ts`), and a second
 *           tap applies the plan that imports them.
 *
 * A service token's secret arrives in the keeper's answer to this process
 * and goes to `security -i` on stdin; it is never printed or written to a file.
 */
import type { FlyResult } from '../../packages/server/src/keeper/keeper-requests.ts';
import { stateCredentials } from './credentials.ts';
import type { MintedToken } from './keeper-run.ts';
import { type TokenServices, tokenServices } from './service-tokens.ts';
import type { TfEnv } from './terraform.ts';
import { CONFIG_PATHS, type ConfigPaths, type ReadConfig } from './vars.ts';

export interface KeeperWrapperIo {
  read: ReadConfig;
  env: Record<string, string | undefined>;
  keychainHas: (name: string) => boolean;
  keychainRead: (name: string) => string;
  keychainHasService: (service: string) => boolean;
  storeToken: (services: TokenServices, clientId: string, secret: string) => void;
  /** One call to the keeper; a hold is waited out inside it. */
  keeper: (command: 'plan' | 'apply', env: TfEnv, input: string) => Promise<FlyResult>;
  out: (s: string) => void;
  err: (s: string) => void;
}

interface Report {
  ok?: boolean;
  mode?: 'plan' | 'apply' | 'mint';
  error?: string;
  refusals?: string[];
  text?: string;
  summary?: string;
  changes?: number;
  missing?: Record<string, string>;
  audiences?: string[];
  minted?: MintedToken[];
}

function reportOf(r: FlyResult): Report | null {
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as Report;
  } catch {
    return null;
  }
}

/** The request body's input: the configs and the state credential, nothing else. */
export function keeperInput(env: TfEnv, io: KeeperWrapperIo): string {
  const configs: Partial<Record<keyof ConfigPaths, string>> = {};
  for (const [k, p] of Object.entries(CONFIG_PATHS[env])) {
    const text = io.read(p);
    if (text !== null) configs[k as keyof ConfigPaths] = text;
  }
  const s = stateCredentials(io);
  const bucket = io.env.CF_TFSTATE_BUCKET?.trim();
  return JSON.stringify({
    configs,
    state: { accessKeyId: s.AWS_ACCESS_KEY_ID, secretAccessKey: s.AWS_SECRET_ACCESS_KEY },
    ...(bucket ? { bucket } : {}),
  });
}

/** A run that failed: what the keeper or terraform said, never a value. */
function failed(io: KeeperWrapperIo, r: FlyResult, rep: Report | null): number {
  if (r.stderr.trim()) io.err(`${r.stderr.trim()}\n`);
  for (const x of rep?.refusals ?? []) io.err(`  - ${x}\n`);
  io.err(`${rep?.error ?? 'the keeper run failed'}\n`);
  return 1;
}

function printPlan(io: KeeperWrapperIo, rep: Report): void {
  io.out(rep.text ?? '');
  for (const name of Object.values(rep.missing ?? {})) {
    const s = tokenServices(name);
    io.out(
      `Service token "${name}" does not exist: cf:apply makes it and stores its pair in the Keychain (${s.clientId}, ${s.secret}).\n`,
    );
  }
}

/** Put each new pair in the Keychain. False, naming what was lost, when one cannot be. */
function storeMinted(io: KeeperWrapperIo, minted: MintedToken[]): boolean {
  for (const t of minted) {
    try {
      io.storeToken(t.services, t.clientId, t.secret);
    } catch {
      // Never the caught message: it was raised next to the secret.
      io.err(
        `Made service token "${t.name}" (${t.id}) but could not store its pair in ${t.services.secret}. Its secret is lost: rotate it in the dashboard, then add the pair to the Keychain by hand.\n`,
      );
      return false;
    }
    io.out(`Made service token "${t.name}"; its pair is in the Keychain.\n`);
  }
  return true;
}

/** Exit code: 0 on success, 1 on a refusal or a failed step. */
export async function runThroughKeeper(
  command: 'plan' | 'apply',
  env: TfEnv,
  io: KeeperWrapperIo,
): Promise<number> {
  try {
    const input = keeperInput(env, io);
    const planned = await io.keeper('plan', env, input);
    const plan = reportOf(planned);
    if (planned.status !== 0 || !plan?.ok) return failed(io, planned, plan);
    printPlan(io, plan);
    if (command === 'plan') return 0;

    const taken = Object.values(plan.missing ?? {}).flatMap((name) => {
      const s = tokenServices(name);
      return [s.clientId, s.secret].filter((x) => io.keychainHasService(x));
    });
    if (taken.length > 0) {
      for (const t of taken) io.err(`  - the Keychain already holds ${t}\n`);
      io.err('Refused before any service token was made; nothing was changed.\n');
      return 1;
    }
    // At most two taps: the tokens, then the plan that imports them.
    for (let round = 0; round < 2; round++) {
      const r = await io.keeper('apply', env, input);
      const rep = reportOf(r);
      if (r.status !== 0 || !rep?.ok) return failed(io, r, rep);
      if (rep.mode === 'plan') {
        io.out(`No changes to apply to ${env}.\n`);
        return 0;
      }
      if (rep.mode === 'apply') {
        io.out(rep.text ?? '');
        for (const l of rep.audiences ?? []) io.out(`${l}\n`);
        io.out(`Applied to ${env}.\n`);
        return 0;
      }
      if (!storeMinted(io, rep.minted ?? [])) return 1;
    }
    io.err('The keeper made service tokens twice without an apply; run cf:apply again.\n');
    return 1;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
