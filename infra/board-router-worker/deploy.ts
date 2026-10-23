#!/usr/bin/env bun
/**
 * Deploy the router Worker and the wildcard DNS record its subdomains need.
 *
 *   bun run router:deploy [--dry-run] [--config <path>]
 *
 * Reads `router.local.json` beside this file (gitignored; README "Deploying"),
 * then, in order:
 *
 *   finds the zone and its account
 *   checks every origin hostname has a proxied record, and that a certificate
 *     covers `*.<one address>`, and stops naming what is missing if not
 *   creates the proxied `*.<one address>` record when there is none
 *   runs `wrangler deploy` and prints the version it deployed
 *
 * A second run changes nothing but the Worker's code and vars. The API token
 * comes out of the Keychain (`cloudflare-api-token`) into this process and a
 * child's environment only: never an argument, a log line or a file.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { keychainHas, keychainRead } from '../project-machine/mac-ops.ts';
import {
  type DnsRecord,
  type Observed,
  type RouterConfig,
  originsOf,
  parseRouterConfig,
  plan,
  renderWranglerToml,
  versionIdOf,
  wildcardRecord,
} from './deploy-plan.ts';

const HERE = dirname(new URL(import.meta.url).pathname);
const API = 'https://api.cloudflare.com/client/v4';
const TOKEN_ENTRY = 'cloudflare-api-token';

interface Envelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

function cloudflare(token: string) {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !json?.success) {
      const why = json?.errors?.map((e) => `${e.code} ${e.message}`).join('; ') ?? res.statusText;
      throw new Error(`${method} ${path.split('?')[0]} failed (${res.status}): ${why}`);
    }
    return json.result;
  };
}

async function observe(
  api: ReturnType<typeof cloudflare>,
  zoneId: string,
  cfg: RouterConfig,
): Promise<Observed> {
  const records = (name: string) =>
    api<DnsRecord[]>('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
  const origins: Record<string, DnsRecord[]> = {};
  for (const origin of originsOf(cfg)) origins[origin] = await records(origin);
  const packs = await api<Array<{ hosts?: string[] }>>(
    'GET',
    `/zones/${zoneId}/ssl/certificate_packs?status=all`,
  );
  return {
    wildcard: await records(wildcardRecord(cfg.oneAddress).name),
    origins,
    certificateHosts: packs.flatMap((p) => p.hosts ?? []),
  };
}

function wrangler(cfg: RouterConfig, token: string, accountId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-router-deploy-'));
  try {
    const config = join(dir, 'wrangler.toml');
    writeFileSync(config, renderWranglerToml(cfg, join(HERE, 'worker.js')));
    const r = spawnSync('wrangler', ['deploy', '-c', config], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: token,
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
  if (!keychainHas(TOKEN_ENTRY)) {
    throw new Error(`the Keychain has no ${TOKEN_ENTRY}; nothing was changed`);
  }
  const token = keychainRead(TOKEN_ENTRY).trim();
  const api = cloudflare(token);

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
  const record = wildcardRecord(cfg.oneAddress);
  console.log(`${record.name}: ${decided.createWildcard ? 'create' : 'exists'}`);
  console.log(`routes: *.${cfg.oneAddress}/*${cfg.bindBoardPaths ? ' and the board paths' : ''}`);
  console.log(`projects: ${Object.keys(cfg.projects).join(', ') || 'none'}`);
  if (dryRun) return;

  if (decided.createWildcard) {
    await api('POST', `/zones/${zone.id}/dns_records`, {
      ...record,
      comment: 'Project subdomains, answered by the board-router Worker',
    });
  }
  const version = wrangler(cfg, token, zone.account.id);
  console.log(`deployed board-router version ${version}`);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
