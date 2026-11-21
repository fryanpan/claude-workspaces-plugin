#!/usr/bin/env bun
/**
 * The half of the daily wall report that needs a Cloudflare or Fly org
 * credential, read in CI (`.github/workflows/wall-read.yml`) and sealed to
 * the Mac, so the Mac reads no Cloudflare or Fly token from its Keychain.
 *
 *   bun infra/project-machine/wall-read.ts cloudflare --out <file>
 *   bun infra/project-machine/wall-read.ts fly --out <file>
 *
 * `cloudflare` runs under `ci-credentials.ts --account-id` in
 * `cloudflare-prod`, with the token and state key cloudflare.yml's apply
 * uses (the repository holds no Cloudflare token of its own). It reads prod's Terraform outputs, each tunnel's
 * ingress, the live Access applications and service token names, and a plan
 * in CI mode (no lock, nothing applied). `fly` runs in `fly-org-read` and
 * reads `fly apps list` (each `cw-` app's name and network) with a read-only
 * token cut from the org token (`ci-tokens.ts` `readCaveats`), so the daily
 * read never holds the org token itself.
 *
 * What it reads holds hostnames, ids and Access policy rules and no
 * credential, but the repository is public and so is the artifact, so the
 * file is sealed to the Mac's committed key (`infra/handoff/`), as every
 * other handoff is. Nothing read is printed: the log names counts only.
 * `wall-read-pull.ts` is the Mac's side.
 */
import { parseArgs } from 'node:util';
import { type TfOutputs, parseOutputs, readOutputs, realOutputIo } from '../cloudflare/outputs.ts';
import { realIo, runWrapper } from '../cloudflare/run.ts';
import { recipientKey } from '../handoff/items.ts';
import { writePrivate } from '../handoff/mac-store.ts';
import { type Envelope, open, seal } from '../handoff/seal.ts';
import { type CloudflareApi, cloudflareApi } from './cloudflare.ts';
import { flyJson } from './mac-ops.ts';
import type { FlyView, Ingress, LiveAccessApp } from './wall-drift.ts';

export type WallReadPart = 'cloudflare' | 'fly';
export const WALL_READ_PARTS: readonly WallReadPart[] = ['cloudflare', 'fly'];
/** The workflow that makes the read, and each part's artifact. */
export const WALL_READ_WORKFLOW = 'wall-read.yml';
export const artifactFor = (part: WallReadPart): string => `wall-read-${part}`;

export interface CloudflareRead {
  part: 'cloudflare';
  /** Milliseconds since the epoch. */
  readAt: number;
  outputs: TfOutputs;
  /** Each tunnel's configuration by tunnel id; null when it was not read. */
  ingress: Record<string, Ingress | null>;
  /** The live Access applications and service token names; null when unread. */
  access: { apps: LiveAccessApp[]; tokenNames: Array<[string, string]> } | null;
  plan: { status: number; summary: string };
}

export interface FlyRead {
  part: 'fly';
  readAt: number;
  apps: FlyView['apps'];
}

export type WallRead = CloudflareRead | FlyRead;

export interface SealedWallRead {
  recipient: 'mac';
  kind: 'wall-read';
  part: WallReadPart;
  envelope: Envelope;
}

export interface CloudflareReadIo {
  outputs: () => TfOutputs;
  api: CloudflareApi;
  plan: () => Promise<{ status: number; summary: string }>;
  now: () => number;
}

const ACCOUNT = /^[0-9a-f]{32}$/;

/** Every Cloudflare read the report judges. A failed read is recorded as null, never skipped. */
export async function readCloudflare(io: CloudflareReadIo): Promise<CloudflareRead> {
  const outputs = io.outputs();
  const ingress: Record<string, Ingress | null> = {};
  for (const t of Object.values(outputs.tunnels)) {
    try {
      const res = await io.api<{ config?: Ingress }>(
        'GET',
        `/accounts/${t.account_id}/cfd_tunnel/${t.id}/configurations`,
      );
      ingress[t.id] = res.config ?? null;
    } catch {
      ingress[t.id] = null;
    }
  }
  let access: CloudflareRead['access'] = null;
  const account = Object.values(outputs.tunnels)[0]?.account_id;
  if (account && ACCOUNT.test(account)) {
    try {
      const apps = await io.api.all<LiveAccessApp>(`/accounts/${account}/access/apps`);
      const tokens = await io.api.all<{ id?: unknown; name?: unknown }>(
        `/accounts/${account}/access/service_tokens`,
      );
      access = {
        // Only what liveAccessRows reads.
        apps: apps.map((a) => ({
          ...(typeof a.name === 'string' ? { name: a.name } : {}),
          ...(Array.isArray(a.policies)
            ? {
                policies: a.policies.map((p) => ({
                  ...(typeof p.decision === 'string' ? { decision: p.decision } : {}),
                  ...(Array.isArray(p.include) ? { include: p.include } : {}),
                })),
              }
            : {}),
        })),
        tokenNames: tokens.map((t) => [String(t.id), String(t.name)]),
      };
    } catch {
      access = null;
    }
  }
  return { part: 'cloudflare', readAt: io.now(), outputs, ingress, access, plan: await io.plan() };
}

const APP = /^cw-[a-z0-9][a-z0-9-]{0,62}$/;

/** Each project app's name and network, from `fly apps list`. Other apps are left out. */
export function readFly(list: FlyView['apps'], now: number): FlyRead {
  const apps: FlyView['apps'] = [];
  for (const a of list) {
    const name = a.Name ?? a.name;
    if (typeof name !== 'string' || !APP.test(name)) continue;
    const network = a.Network ?? a.network;
    apps.push({ Name: name, ...(typeof network === 'string' ? { Network: network } : {}) });
  }
  return { part: 'fly', readAt: now, apps };
}

export function sealWallRead(publicKey: string, read: WallRead): SealedWallRead {
  return {
    recipient: 'mac',
    kind: 'wall-read',
    part: read.part,
    envelope: seal(publicKey, JSON.stringify(read)),
  };
}

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Re-check outputs that crossed in a file, through the parser `terraform output` uses. */
function checkOutputs(raw: unknown): TfOutputs {
  const o = obj(raw);
  return parseOutputs(
    JSON.stringify({
      access: { value: o.access },
      tunnels: { value: o.tunnels },
      router_routes: { value: o.routerRoutes },
      access_team_domain: { value: o.accessTeamDomain },
    }),
  );
}

function checkCloudflare(r: Record<string, unknown>): CloudflareRead {
  const plan = obj(r.plan);
  if (!Number.isSafeInteger(plan.status) || typeof plan.summary !== 'string')
    throw new Error('the Cloudflare read has no plan');
  const ingress: Record<string, Ingress | null> = {};
  for (const [id, v] of Object.entries(obj(r.ingress))) {
    const c = obj(v);
    ingress[id] = v === null ? null : Array.isArray(c.ingress) ? (c as Ingress) : {};
  }
  const a = r.access === null ? null : obj(r.access);
  const access =
    a && Array.isArray(a.apps) && Array.isArray(a.tokenNames)
      ? {
          apps: a.apps.map((x) => obj(x) as LiveAccessApp),
          tokenNames: a.tokenNames
            .filter((t): t is [unknown, unknown] => Array.isArray(t) && t.length === 2)
            .map(([id, name]): [string, string] => [String(id), String(name)]),
        }
      : null;
  return {
    part: 'cloudflare',
    readAt: r.readAt as number,
    outputs: checkOutputs(r.outputs),
    ingress,
    access,
    plan: { status: plan.status as number, summary: plan.summary },
  };
}

/** Open a sealed read with the Mac's private key; throws unless it is the part asked for. */
export function openWallRead(privateKey: string, text: string, part: 'cloudflare'): CloudflareRead;
export function openWallRead(privateKey: string, text: string, part: 'fly'): FlyRead;
export function openWallRead(privateKey: string, text: string, part: WallReadPart): WallRead;
export function openWallRead(privateKey: string, text: string, part: WallReadPart): WallRead {
  const s = obj(JSON.parse(text));
  if (s.recipient !== 'mac' || s.kind !== 'wall-read')
    throw new Error('not a wall read for the Mac');
  if (s.part !== part) throw new Error(`a ${String(s.part)} read, not ${part}`);
  const r = obj(JSON.parse(open(privateKey, s.envelope as Envelope)));
  // The envelope's own part must match the label outside it.
  if (r.part !== part) throw new Error(`the envelope holds a ${String(r.part)} read, not ${part}`);
  if (!Number.isSafeInteger(r.readAt)) throw new Error('the read has no time');
  if (part === 'fly') {
    if (!Array.isArray(r.apps)) throw new Error('the Fly read has no apps');
    return readFly(r.apps as FlyView['apps'], r.readAt as number);
  }
  return checkCloudflare(r);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { out: { type: 'string' } },
    allowPositionals: true,
  });
  const part = positionals[0];
  if ((part !== 'cloudflare' && part !== 'fly') || !values.out)
    throw new Error('usage: wall-read.ts cloudflare|fly --out <file>');
  const key = recipientKey('mac');
  let read: WallRead;
  if (part === 'fly') {
    read = readFly(flyJson<FlyView['apps']>(['apps', 'list']), Date.now());
    console.log(`[wall-read] ${read.apps.length} project app(s) read`);
  } else {
    const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
    if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set');
    read = await readCloudflare({
      outputs: () => readOutputs('prod', realOutputIo('prod')),
      api: cloudflareApi(token),
      plan: async () => {
        let summary = '';
        const status = await runWrapper(
          'plan',
          { env: 'prod', ci: true },
          { ...realIo('prod'), out: (s) => (summary += s), err: (s) => process.stderr.write(s) },
        );
        return { status, summary };
      },
      now: Date.now,
    });
    const unread = Object.values(read.ingress).filter((c) => c === null).length;
    console.log(
      `[wall-read] ${Object.keys(read.outputs.tunnels).length} tunnel(s), ${unread} ingress unread, Access ${read.access ? 'read' : 'unread'}, plan exited ${read.plan.status}`,
    );
  }
  writePrivate(values.out, JSON.stringify(sealWallRead(key, read)));
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`[wall-read] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
