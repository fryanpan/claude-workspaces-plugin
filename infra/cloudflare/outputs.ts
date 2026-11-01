/**
 * An environment's Terraform outputs, for `machine:deploy`: each project's
 * Access audience and hostnames, the Access team domain, and each project
 * machine's tunnel with its token. `machine:deploy` takes everything it needs
 * from Cloudflare from here and makes no Cloudflare call of its own.
 *
 * Reading them needs only the state bucket's credential (`credentials.ts`),
 * never the API token. The -backend-config file is the one `cf:plan` last
 * wrote to `state/<env>/`; where none exists (a fresh CI runner) it is built
 * from CLOUDFLARE_ACCOUNT_ID.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keychainHas, keychainRead } from '../project-machine/mac-ops.ts';
import {
  type CredentialSources,
  DEFAULT_STATE_BUCKET,
  backendConfig,
  stateCredentials,
} from './credentials.ts';
import { type TfEnv, type TfResult, envDir, spawnTerraform, stateDir } from './terraform.ts';

export interface AccessOutput {
  aud: string;
  hosts: string[];
}

export interface TunnelOutput {
  id: string;
  name: string;
  origin: string;
  public_host: string;
}

export interface TfOutputs {
  access: Record<string, AccessOutput>;
  accessTeamDomain: string | null;
  tunnels: Record<string, TunnelOutput>;
  /** Credentials: held in memory, never printed. */
  tunnelTokens: Record<string, string>;
}

type Raw = Record<string, { value?: unknown } | undefined>;

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** `terraform output -json`, checked. A missing output reads as empty. */
export function parseOutputs(json: string): TfOutputs {
  const raw = JSON.parse(json) as Raw;
  const access: Record<string, AccessOutput> = {};
  for (const [label, v] of Object.entries(record(raw.access?.value))) {
    const p = record(v);
    if (typeof p.aud === 'string' && Array.isArray(p.hosts)) {
      access[label] = {
        aud: p.aud,
        hosts: p.hosts.filter((h): h is string => typeof h === 'string'),
      };
    }
  }
  const tunnels: Record<string, TunnelOutput> = {};
  for (const [label, v] of Object.entries(record(raw.tunnels?.value))) {
    const t = record(v);
    if ([t.id, t.name, t.origin, t.public_host].every((x) => typeof x === 'string')) {
      tunnels[label] = t as unknown as TunnelOutput;
    }
  }
  const tunnelTokens: Record<string, string> = {};
  for (const [label, v] of Object.entries(record(raw.tunnel_tokens?.value))) {
    if (typeof v === 'string') tunnelTokens[label] = v;
  }
  const team = raw.access_team_domain?.value;
  return {
    access,
    accessTeamDomain: typeof team === 'string' && team !== '' ? team : null,
    tunnels,
    tunnelTokens,
  };
}

export interface OutputIo extends CredentialSources {
  backendExists: (path: string) => boolean;
  writeBackend: (path: string, content: string) => void;
  terraform: (args: string[], env: Record<string, string>, capture?: boolean) => TfResult;
}

/** Init against the environment's R2 state and read every output. */
export function readOutputs(tfEnv: TfEnv, io: OutputIo = realOutputIo(tfEnv)): TfOutputs {
  const env = stateCredentials(io);
  const backend = join(stateDir(tfEnv), 'backend.hcl');
  if (!io.backendExists(backend)) {
    const account = io.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    if (!account) {
      throw new Error(
        `no ${backend} and no CLOUDFLARE_ACCOUNT_ID: run bun run cf:plan ${tfEnv} once, or set it`,
      );
    }
    const bucket = io.env.CF_TFSTATE_BUCKET?.trim() || DEFAULT_STATE_BUCKET;
    io.writeBackend(backend, backendConfig(tfEnv, account, bucket));
  }
  const init = io.terraform(
    ['init', '-input=false', '-lockfile=readonly', '-reconfigure', `-backend-config=${backend}`],
    env,
    true,
  );
  if (init.status !== 0) throw new Error(`terraform init for ${tfEnv} exited ${init.status}`);
  const out = io.terraform(['output', '-json'], env, true);
  if (out.status !== 0) throw new Error(`terraform output for ${tfEnv} exited ${out.status}`);
  return parseOutputs(out.stdout || '{}');
}

function realOutputIo(tfEnv: TfEnv): OutputIo {
  const dir = stateDir(tfEnv);
  return {
    env: process.env,
    keychainHas,
    keychainRead,
    backendExists: existsSync,
    writeBackend: (path, content) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path, content, { mode: 0o600 });
    },
    terraform: (args, env, capture) => spawnTerraform(envDir(tfEnv), args, env, capture, dir),
  };
}
