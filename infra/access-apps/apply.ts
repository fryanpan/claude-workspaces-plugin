#!/usr/bin/env bun
/**
 * Create or update the Access applications `access.local.json` describes.
 *
 *   bun run access:apply [<path>]            # dry run: reads only
 *   bun run access:apply --apply [<path>]    # writes
 *
 * Reads the config `plan.ts` reads, then the account's Access applications
 * and service tokens, and decides per project whether to create or update the
 * application named `board <project>` (`apply-plan.ts`, which also holds every
 * refusal). A dry run, the default, prints that plan and sends no write.
 * `--apply` sends the writes, reads each application back, and prints the
 * `CF_ACCESS_AUD` and `CF_ACCESS_HOST_AUDS` each project's server needs. A
 * second `--apply` with no config change sends no write.
 *
 * Credentials come from the environment only, under wrangler's names:
 * `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token goes into the
 * Authorization header and nowhere else. `CW_CLOUDFLARE_API_BASE` points the
 * calls at a loopback test server and accepts nothing else.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cloudflareApi } from '../project-machine/cloudflare.ts';
import { hostAudiencesFor, parseAccessConfig } from './access-plan.ts';
import { type ExistingApp, type ServiceToken, decide } from './apply-plan.ts';

export interface RunIo {
  argv: string[];
  env: Record<string, string | undefined>;
  out: (s: string) => void;
  err: (s: string) => void;
}

const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const LOOPBACK_BASE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(\/|$)/;

/** Exit code 0 on success, 1 on a refusal or a failed call. */
export async function run(io: RunIo): Promise<number> {
  try {
    return await apply(io);
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

async function apply({ argv, env, out, err }: RunIo): Promise<number> {
  const write = argv.includes('--apply');
  if (write && argv.includes('--dry-run')) {
    err('Pass --apply or --dry-run, not both.\n');
    return 1;
  }
  const unknown = argv.filter((a) => a.startsWith('--') && a !== '--apply' && a !== '--dry-run');
  if (unknown.length > 0) {
    err(`Unknown flag ${unknown[0]}.\n`);
    return 1;
  }
  const path =
    argv.find((a) => !a.startsWith('--')) ?? join(import.meta.dirname, 'access.local.json');
  const cfg = parseAccessConfig(readFileSync(path, 'utf8'));

  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) {
    err('CLOUDFLARE_API_TOKEN is not set; nothing was read or changed.\n');
    return 1;
  }
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
  if (!ACCOUNT_ID.test(account)) {
    err(
      'CLOUDFLARE_ACCOUNT_ID is not set to a 32-character account id; nothing was read or changed.\n',
    );
    return 1;
  }
  const base = env.CW_CLOUDFLARE_API_BASE?.trim();
  if (base && !LOOPBACK_BASE.test(base)) {
    err('CW_CLOUDFLARE_API_BASE must be a loopback http address; it exists for tests.\n');
    return 1;
  }
  const api = cloudflareApi(token, base ? { base } : {});
  const access = `/accounts/${account}/access`;

  const listed = await api.all<ExistingApp>(`${access}/apps`);
  const tokens = await api.all<ServiceToken>(`${access}/service_tokens`);
  const owned = new Set(Object.keys(cfg.projects).map((l) => `board ${l}`));
  // The listing may omit policies, so each application the config owns is
  // read on its own: without them every run would read as an update.
  const apps: ExistingApp[] = [];
  for (const a of listed) {
    apps.push(owned.has(a.name) ? await api<ExistingApp>('GET', `${access}/apps/${a.id}`) : a);
  }

  const decision = decide(cfg, account, apps, tokens);
  if (!decision.ok) {
    for (const r of decision.refusals) err(`${r}\n`);
    err('Refused; nothing was changed.\n');
    return 1;
  }
  for (const s of decision.steps) {
    const what = s.action === 'update' ? `update (${s.changed.join(', ')})` : s.action;
    out(`${s.name}: ${what}\n`);
  }
  if (!write) {
    const n = decision.writes.length;
    out(
      `dry run: no write sent. ${n === 0 ? 'Nothing to change.' : `--apply would send ${n} write${n === 1 ? '' : 's'}.`}\n`,
    );
    return 0;
  }
  if (decision.writes.length === 0)
    out('no write: every application already matches the config.\n');

  const idOf = new Map<string, string>();
  for (const s of decision.steps) if (s.action !== 'create') idOf.set(s.label, s.id);
  for (const w of decision.writes) {
    const app = await api<ExistingApp>(w.method, w.path, w.body);
    idOf.set(w.label, app.id);
    out(`${w.body.name}: ${w.method === 'POST' ? 'created' : 'updated'}\n`);
  }

  const audOf = new Map<string, string>();
  for (const [label, id] of idOf) {
    const app = await api<ExistingApp>('GET', `${access}/apps/${id}`);
    if (!app.aud) throw new Error(`board ${label} was read back with no aud`);
    audOf.set(label, app.aud);
  }
  for (const label of Object.keys(cfg.projects)) {
    const auds = hostAudiencesFor(cfg, [label], (l) => audOf.get(l) as string);
    out(`${label}: CF_ACCESS_AUD=${audOf.get(label)}\n`);
    out(`${label}: CF_ACCESS_HOST_AUDS='${JSON.stringify(auds)}'\n`);
  }
  return 0;
}

if (import.meta.main) {
  run({
    argv: process.argv.slice(2),
    env: process.env,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  }).then((code) => process.exit(code));
}
