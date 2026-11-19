#!/usr/bin/env bun
/**
 * The `cloudflare-prod` half of fly-provision.yml (`provision.ts` is the
 * other): read what only this environment can, and seal it to `fly-org`.
 *
 *   bun infra/cloudflare/ci-credentials.ts --account-id -- \
 *     bun infra/project-machine/provision-outputs.ts --project <name>
 *
 * For the project in machines.json it reads the Terraform outputs with the
 * state key, then
 *
 *   CLOUDFLARE_TUNNEL_TOKEN  for a named tunnel, from Cloudflare's API with
 *                            the apply token (`tunnel-plan.ts`)
 *   the Access settings      CW_PUBLIC_BASE_URL and the four CF_ACCESS_* /
 *                            trusted-host values (`settings.ts`), each when
 *                            the outputs hold its source
 *
 * and writes them, sealed to `fly-org`'s committed key, to the file
 * CW_PROVISION_HANDOFF_OUT names, for the workflow to upload. The repository
 * is public and so is the artifact; only `fly-org`'s HANDOFF_PRIVATE_KEY
 * opens it. Lines name secrets, never a value.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { type TfOutputs, readOutputs } from '../cloudflare/outputs.ts';
import { HandoffSink, recipientKey } from '../handoff/items.ts';
import { cloudflareApi } from './cloudflare.ts';
import { type ProjectConfig, projectConfig } from './deploy-plan.ts';
import { MACHINES_FILE, parseMachines } from './machines.ts';
import { readSettings } from './settings.ts';
import {
  type AppliedTunnel,
  TUNNEL_TOKEN_SECRET,
  appliedTunnel,
  readTunnelToken,
} from './tunnel-plan.ts';

export interface OutputsIo {
  machines: () => string;
  outputs: () => TfOutputs;
  tunnelToken: (t: AppliedTunnel) => Promise<string>;
  /** fly-org's public key. */
  recipient: () => string;
  write: (path: string, text: string) => void;
  out: (s: string) => void;
}

/** Exit code: 0 written, 1 refused, 2 bad usage. */
export async function provisionOutputs(
  argv: string[],
  env: Record<string, string | undefined>,
  io: OutputsIo,
): Promise<number> {
  const i = argv.indexOf('--project');
  const project = i >= 0 ? argv[i + 1] : undefined;
  const outPath = env.CW_PROVISION_HANDOFF_OUT?.trim();
  if (!project || !outPath) {
    io.out('usage: CW_PROVISION_HANDOFF_OUT=<file> provision-outputs.ts --project <name>\n');
    return 2;
  }
  const say = (s: string) => io.out(`[provision-outputs] ${s}\n`);
  try {
    const entry = parseMachines(io.machines()).find((m) => m.project === project);
    if (!entry)
      throw new Error(`machines.json lists no ${project}; add it in a pull request first`);
    const cfg: ProjectConfig = projectConfig({
      project,
      imageLabel: '0'.repeat(40),
      tunnel: entry.tunnel,
    });
    const key = io.recipient();
    const outputs = io.outputs();
    const secrets: Record<string, string> = {};
    if (cfg.tunnel === 'named') {
      secrets[TUNNEL_TOKEN_SECRET] = await io.tunnelToken(appliedTunnel(outputs, cfg));
    }
    const found = readSettings(project, {
      outputs: () => outputs,
      // The owner's address is the Mac's (or fly.yml's) to set, not this job's.
      keychainHas: () => false,
      keychainRead: () => {
        throw new Error('no Keychain here');
      },
    });
    for (const s of found.settings) secrets[s.name] = s.value();
    for (const line of found.skipped)
      if (!/^CW_(OWNER_EMAIL|GOOGLE_CLIENT_ID)/.test(line)) say(`not sealed: ${line}`);
    const sink = new HandoffSink('fly-org', outPath);
    sink.add({ kind: 'fly-secrets', app: cfg.app, secrets });
    sink.flush(key, io.write);
    say(`sealed to fly-org for ${cfg.app}: ${Object.keys(secrets).join(', ') || 'nothing'}`);
    return 0;
  } catch (e) {
    say(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  provisionOutputs(process.argv.slice(2), process.env, {
    machines: () => readFileSync(MACHINES_FILE, 'utf8'),
    outputs: () => readOutputs('prod'),
    tunnelToken: (t) => {
      if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set');
      return readTunnelToken(cloudflareApi(token), t);
    },
    recipient: () => recipientKey('fly-org'),
    write: (p, t) => writeFileSync(p, t, { mode: 0o600 }),
    out: (s) => process.stdout.write(s),
  }).then((code) => process.exit(code));
}
