#!/usr/bin/env bun
/**
 * Deploy the router Worker and the DNS record each project's hostname needs.
 *
 *   bun run router:deploy [--dry-run] [--config <path>]
 *
 * Reads `router.local.json` beside this file (gitignored; README "Deploying"),
 * then, in order:
 *
 *   finds the zone and its account
 *   checks every origin hostname has a proxied record, and that a certificate
 *     covers every project hostname `<project>-<first label>.<zone>` (the
 *     zone's Universal SSL does), and stops naming what is missing if not
 *   creates the proxied record for each project hostname that has none
 *   runs `wrangler deploy` and prints the version it deployed
 *
 * A second run changes nothing but the Worker's code and vars. With
 * `CW_KEEPER_URL` set, the API calls go through the keeper (the record write
 * waits for Bryan's passkey) and `wrangler deploy` runs on wrangler's own
 * login, so no token is read here. Without it, the API token comes out of
 * the Keychain (`cloudflare-api-token`) into this process and a child's
 * environment only: never an argument, a log line or a file.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CloudflareApi } from '../project-machine/cloudflare.ts';
import { cloudflareApiToken, cloudflareClient } from '../project-machine/mac-ops.ts';
import {
  type DnsRecord,
  type Observed,
  type RouterConfig,
  originsOf,
  parseRouterConfig,
  plan,
  projectHostsOf,
  projectRecord,
  renderWranglerToml,
  versionIdOf,
} from './deploy-plan.ts';

const HERE = dirname(new URL(import.meta.url).pathname);

async function observe(api: CloudflareApi, zoneId: string, cfg: RouterConfig): Promise<Observed> {
  const records = (name: string) =>
    api<DnsRecord[]>('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
  const origins: Record<string, DnsRecord[]> = {};
  for (const origin of originsOf(cfg)) origins[origin] = await records(origin);
  const hosts: Record<string, DnsRecord[]> = {};
  for (const host of projectHostsOf(cfg)) hosts[host] = await records(host);
  const packs = await api<Array<{ hosts?: string[] }>>(
    'GET',
    `/zones/${zoneId}/ssl/certificate_packs?status=all`,
  );
  return {
    hosts,
    origins,
    certificateHosts: packs.flatMap((p) => p.hosts ?? []),
  };
}

/** `token` null: wrangler uses its own login (`wrangler login`), as after the keeper's cutover. */
function wrangler(cfg: RouterConfig, token: string | null, accountId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-router-deploy-'));
  try {
    const config = join(dir, 'wrangler.toml');
    writeFileSync(config, renderWranglerToml(cfg, join(HERE, 'worker.js')));
    const r = spawnSync('wrangler', ['deploy', '-c', config], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(token === null ? {} : { CLOUDFLARE_API_TOKEN: token }),
        CLOUDFLARE_ACCOUNT_ID: accountId,
        WRANGLER_SEND_METRICS: 'false',
      },
    });
    if (r.error) throw new Error(`could not run wrangler: ${r.error.message}`);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    process.stdout.write(out);
    if (r.status !== 0) throw new Error(`wrangler deploy exited ${r.status}`);
    const version = versionIdOf(out);
    if (!version) throw new Error('wrangler deploy printed no version id');
    return version;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const i = args.indexOf('--config');
  const cfg = parseRouterConfig(
    readFileSync(i >= 0 ? (args[i + 1] ?? '') : join(HERE, 'router.local.json'), 'utf8'),
  );
  const viaKeeper = Boolean(process.env.CW_KEEPER_URL?.trim());
  const api = cloudflareClient('router:deploy');

  const zones = await api<Array<{ id: string; account: { id: string } }>>(
    'GET',
    `/zones?name=${encodeURIComponent(cfg.zone)}`,
  );
  const zone = zones[0];
  if (!zone) throw new Error(`the token sees no zone named ${cfg.zone}`);

  const decided = plan(cfg, await observe(api, zone.id, cfg));
  if (!decided.ok) {
    for (const p of decided.problems) console.error(`  - ${p}`);
    throw new Error('not deployed; nothing was changed');
  }
  for (const host of projectHostsOf(cfg)) {
    console.log(`${host}/*: ${decided.create.includes(host) ? 'create record' : 'record exists'}`);
  }
  if (cfg.bindBoardPaths) console.log(`${cfg.oneAddress}/workspaces/*: bound`);
  if (dryRun) return;

  for (const host of decided.create) {
    await api('POST', `/zones/${zone.id}/dns_records`, {
      ...projectRecord(host),
      comment: "A project's own hostname, answered by the board-router Worker",
    });
  }
  const version = wrangler(cfg, viaKeeper ? null : cloudflareApiToken(), zone.account.id);
  console.log(`deployed board-router version ${version}`);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
