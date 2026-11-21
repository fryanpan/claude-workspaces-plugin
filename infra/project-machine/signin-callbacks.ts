#!/usr/bin/env bun
/**
 * The Google console lines the shared sign-in client needs: one authorized
 * redirect URI and one JavaScript origin for the Mac's address and for each
 * project machine `machines.json` names.
 *
 *   bun run signin:callbacks [--mac-host <host>] [--tf-env prod|staging]
 *
 * A project's address is the one `machine:deploy` gives it as
 * CW_SIGNIN_ORIGIN (`settings.ts` `signInHost`: its router host), read from
 * the same Terraform outputs (`mac-outputs.ts`: the state with a credential,
 * else the newest sealed wall read). Prints hostnames only.
 */
import { readFileSync } from 'node:fs';
import type { TfOutputs } from '../cloudflare/outputs.ts';
import { isEnv } from '../cloudflare/terraform.ts';
import { macOutputs } from './mac-outputs.ts';
import { MACHINES_FILE, parseMachines } from './machines.ts';
import { googleRedirectUri, signInHost } from './settings.ts';

/** The Mac's own address. */
export const MAC_HOST = 'workspaces.fryanpan.com';

export function callbackLines(
  macHost: string,
  projects: readonly string[],
  outputs: () => TfOutputs,
): string[] {
  const hosts: { label: string; host: string }[] = [{ label: 'the Mac', host: macHost }];
  const missing: string[] = [];
  if (projects.length > 0) {
    let read: TfOutputs | null = null;
    try {
      read = outputs();
    } catch (e) {
      missing.push(
        `projects ${projects.join(', ')}: could not read the Terraform outputs (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    for (const project of read ? projects : []) {
      const found = signInHost(read as TfOutputs, project);
      if ('error' in found) missing.push(`${project}: ${found.error}`);
      else hosts.push({ label: project, host: found.host });
    }
  }
  return [
    'Authorized redirect URIs:',
    ...hosts.map((h) => `  ${googleRedirectUri(h.host)}    (${h.label})`),
    'Authorized JavaScript origins:',
    ...hosts.map((h) => `  https://${h.host}    (${h.label})`),
    ...(missing.length ? ['Not listed:', ...missing.map((m) => `  ${m}`)] : []),
  ];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const after = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const tfEnv = after('--tf-env') ?? 'prod';
  if (!isEnv(tfEnv)) {
    process.stderr.write(`--tf-env is prod or staging (got ${tfEnv})\n`);
    process.exit(2);
  }
  const projects = parseMachines(readFileSync(MACHINES_FILE, 'utf8')).map((m) => m.project);
  const lines = callbackLines(after('--mac-host') ?? MAC_HOST, projects, () => macOutputs(tfEnv));
  process.stdout.write(`${lines.join('\n')}\n`);
}
