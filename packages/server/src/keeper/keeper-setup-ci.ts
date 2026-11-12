/**
 * The `CI credentials` step of `keeper-setup.ts`: the four Cloudflare
 * credentials `.github/workflows/cloudflare.yml` runs with, made once and
 * written to GitHub through the keeper, so no apply ever needs Bryan at a
 * terminal again.
 *
 * - The apply token (`CF_APPLY_PERMISSIONS`) and a read-write R2 key on the
 *   state bucket go to the environment `cloudflare-prod`, which only `main`
 *   may deploy to.
 * - The plan token (the Read form of each) and a read-only R2 key go to the
 *   repository, where a pull request's plan reads them.
 *
 * An R2 key is an API token too: its access key id is the token's id and its
 * secret is the SHA-256 of the token's value (Cloudflare's R2 "S3 API
 * credentials from an API token"). The four are made with the Keychain's
 * current Cloudflare token, or, when that cannot make tokens, with one Bryan
 * pastes for this step; neither is stored. The values go from Cloudflare's
 * answer into one `github-secrets` request and nowhere else: never printed,
 * never in a file or an argument. The keeper holds that request for a passkey
 * tap whose page lists the secret names only. If anything after the first
 * token fails, every token made in this run is deleted again.
 *
 * Skipped when GitHub already holds all six names, and, with a line saying
 * so, when the keeper holds no GitHub token yet; refused, before anything is
 * made, when its GitHub token lacks the classic `repo` scope that writing
 * Actions secrets needs.
 */
import { createHash } from 'node:crypto';
import { keeperGet, keeperHeld } from './keeper-client.ts';
import {
  CI_ENVIRONMENT,
  CI_REPO,
  CREDENTIAL_SECRETS,
  type SecretTarget,
  type SecretWrite,
} from './keeper-github.ts';
import { type CfAccount, cfCall, oneAccount } from './keeper-setup-cloudflare.ts';

type Scope = 'account' | 'zone' | 'bucket';

interface Need {
  api: string;
  scope: Scope;
}

const need = (api: string, scope: Scope): Need => ({ api, scope });

/** The apply token's permissions, as `GET /user/tokens/permission_groups` names them. */
export const CF_APPLY_PERMISSIONS: readonly Need[] = [
  need('Access: Apps and Policies Write', 'account'),
  need('Access: Service Tokens Write', 'account'),
  need('Access: Organizations, Identity Providers, and Groups Read', 'account'),
  need('Cloudflare Tunnel Write', 'account'),
  need('Workers Scripts Write', 'account'),
  need('Zone Read', 'zone'),
  need('DNS Write', 'zone'),
  need('SSL and Certificates Read', 'zone'),
  need('Workers Routes Write', 'zone'),
];

/** The plan token's: the Read form of each. */
export const CF_PLAN_PERMISSIONS: readonly Need[] = CF_APPLY_PERMISSIONS.map((p) =>
  need(p.api.replace(/ Write$/, ' Read'), p.scope),
);

const R2_WRITE = [need('Workers R2 Storage Bucket Item Write', 'bucket')];
const R2_READ = [need('Workers R2 Storage Bucket Item Read', 'bucket')];
const DEFAULT_BUCKET = 'claude-workspaces-tfstate';

export interface CiStepIo {
  keeperUrl: string;
  callerToken: string | null;
  dryRun: boolean;
  fetch: typeof fetch;
  /** The account the setup already confirmed, when it has one. */
  account: CfAccount | null;
  /** The Keychain's current Cloudflare token, read only when a run needs it. */
  current: () => string | null;
  /** The state bucket, `CF_TFSTATE_BUCKET` when set. */
  bucket?: string;
  readSecret: (prompt: string) => Promise<string>;
  readLine: (prompt: string) => Promise<string>;
  print: (line: string) => void;
  /** How long to wait for the tap. Default 10 minutes. */
  waitMs?: number;
  pollMs?: number;
}

export type CiStepResult = { ok: true } | { stop: string };

interface Made {
  id: string;
  value: string;
}

/** The token Bryan pastes when the current one cannot make tokens. */
export function pasteSteps(): string[] {
  return [
    'Make a token that can make tokens, for this step only: My Profile > API Tokens >',
    '   Create Token > Custom token, with the one permission User > API Tokens > Edit.',
    '   It is used for the next minute and kept nowhere; delete it afterwards.',
  ];
}

export async function ciCredentials(io: CiStepIo): Promise<CiStepResult> {
  const ok = (s: string) => io.print(`   ok: ${s}`);
  const would = (s: string) => io.print(`   would ${s}`);
  if (io.callerToken === null) {
    would('read which CI secrets GitHub holds through the keeper, and make the missing ones');
    return { ok: true };
  }
  const opts = { callerToken: io.callerToken, fetchImpl: io.fetch, requester: 'keeper-setup' };
  const status = await keeperGet(io.keeperUrl, '/v1/github-status', opts);
  let read: { scopes?: string[]; names?: Partial<Record<SecretTarget, string[]>>; error?: string };
  try {
    read = JSON.parse(status.body);
  } catch {
    read = {};
  }
  if (status.status !== 200) {
    // Not a stop: the steps after this one do not need GitHub.
    io.print(
      `   skipped: the keeper could not read GitHub (${read.error ?? `status ${status.status}`}). Import a classic token with repo scope as github-token (docs/process/keeper.md, "The GitHub token"), then run this again`,
    );
    return { ok: true };
  }
  const has = (t: SecretTarget) =>
    CREDENTIAL_SECRETS.every((n) => (read.names?.[t] ?? []).includes(n));
  if (has('repository') && has(CI_ENVIRONMENT)) {
    ok(`GitHub holds the CI credentials already (${CI_REPO})`);
    return { ok: true };
  }
  if (!(read.scopes ?? []).includes('repo'))
    return {
      stop: `the keeper's GitHub token does not have the classic repo scope, which writing Actions secrets on ${CI_REPO} needs. Import a classic token with repo scope as github-token, then run this again`,
    };
  if (io.dryRun) {
    would('make an apply token, a plan token and two R2 keys on the state bucket');
    would(`ask the keeper to write them to ${CI_REPO}, held for your passkey`);
    return { ok: true };
  }

  const current = io.current();
  const tried = current ? await permissionGroups(io.fetch, current) : null;
  let maker: { token: string; ids: Map<string, string>; pasted: boolean };
  if (current && tried && !('why' in tried)) {
    maker = { token: current, ids: tried.ids, pasted: false };
  } else {
    io.print(
      `   The current token cannot make tokens (${tried && 'why' in tried ? tried.why : 'the Keychain holds none'}).`,
    );
    for (const l of pasteSteps()) io.print(`   ${l}`);
    const token = (
      await io.readSecret('   Paste that token here (it is not shown), then press Return: ')
    ).trim();
    if (!token || /\s/.test(token)) return { stop: 'that was not one token; nothing was made' };
    const groups = await permissionGroups(io.fetch, token);
    if ('why' in groups) return { stop: `the pasted token: ${groups.why}; nothing was made` };
    maker = { token, ids: groups.ids, pasted: true };
  }
  const seen = await oneAccount(io.fetch, maker.token);
  if ('why' in seen) return { stop: `the token that makes them: ${seen.why}; nothing was made` };
  if (io.account && seen.id !== io.account.id)
    return { stop: 'that token sees a different account than the one you confirmed' };
  io.print(`   Cloudflare account: ${seen.name}`);
  io.print(`   GitHub repository:  ${CI_REPO}`);
  if (!/^\s*y(es)?\s*$/i.test(await io.readLine('   Make the four CI credentials? [y/N] ')))
    return { stop: 'you did not confirm; nothing was made' };

  const bucket = io.bucket?.trim() || DEFAULT_BUCKET;
  const stamp = new Date().toISOString().slice(0, 16);
  const want: Array<[string, readonly Need[]]> = [
    ['apply', CF_APPLY_PERMISSIONS],
    ['plan', CF_PLAN_PERMISSIONS],
    ['state read-write', R2_WRITE],
    ['state read-only', R2_READ],
  ];
  const made: Made[] = [];
  const undo = async (why: string): Promise<CiStepResult> => {
    const left = [];
    for (const m of made) {
      const r = await cfCall(io.fetch, maker.token, 'DELETE', `/user/tokens/${m.id}`);
      if (!r.ok) left.push(m.id);
    }
    const tail = left.length
      ? ` Delete these tokens in the dashboard (My Profile > API Tokens): ${left.join(', ')}`
      : ' Every token this step made was deleted again.';
    return { stop: `${why}.${tail}` };
  };
  for (const [label, perms] of want) {
    const r = await makeToken(
      io.fetch,
      maker.token,
      maker.ids,
      seen.id,
      bucket,
      label,
      perms,
      stamp,
    );
    if ('why' in r) return undo(`making the ${label} token: ${r.why}`);
    made.push(r);
  }
  const [apply, plan, rw, ro] = made as [Made, Made, Made, Made];
  ok('made the apply token, the plan token and two R2 keys');
  const r2 = (target: SecretTarget, m: Made): SecretWrite[] => [
    { target, name: 'R2_ACCESS_KEY_ID', value: m.id },
    {
      target,
      name: 'R2_SECRET_ACCESS_KEY',
      value: createHash('sha256').update(m.value).digest('hex'),
    },
  ];
  const secrets: SecretWrite[] = [
    { target: CI_ENVIRONMENT, name: 'CLOUDFLARE_API_TOKEN', value: apply.value },
    ...r2(CI_ENVIRONMENT, rw),
    { target: 'repository', name: 'CLOUDFLARE_API_TOKEN', value: plan.value },
    ...r2('repository', ro),
  ];
  const written = await keeperHeld(
    io.keeperUrl,
    '/v1/github-secrets',
    { secrets },
    {
      ...opts,
      ...(io.waitMs ? { waitMs: io.waitMs } : {}),
      ...(io.pollMs ? { pollMs: io.pollMs } : {}),
      onHeld: (h) => io.print(`   The write waits for your passkey: ${h.approveUrl}`),
    },
  );
  if (written.status !== 200) {
    let error = `status ${written.status}`;
    try {
      error = (JSON.parse(written.body) as { error?: string }).error ?? error;
    } catch {}
    return undo(`GitHub did not take the secrets (${error})`);
  }
  ok(
    `wrote the CI credentials to ${CI_REPO}: the environment ${CI_ENVIRONMENT} and the repository`,
  );
  if (maker.pasted) io.print('   Delete the token you pasted: My Profile > API Tokens.');
  return { ok: true };
}

async function permissionGroups(
  doFetch: typeof fetch,
  token: string,
): Promise<{ ids: Map<string, string> } | { why: string }> {
  const r = await cfCall(doFetch, token, 'GET', '/user/tokens/permission_groups');
  if (!r.ok) return { why: r.why };
  const ids = new Map<string, string>();
  for (const g of Array.isArray(r.result) ? r.result : []) {
    const { id, name } = g as { id?: unknown; name?: unknown };
    if (typeof id === 'string' && typeof name === 'string') ids.set(name, id);
  }
  const all = [...CF_APPLY_PERMISSIONS, ...CF_PLAN_PERMISSIONS, ...R2_WRITE, ...R2_READ];
  const missing = [...new Set(all.filter((p) => !ids.has(p.api)).map((p) => p.api))];
  return missing.length
    ? { why: `Cloudflare lists no permission named ${missing.join(', ')}` }
    : { ids };
}

async function makeToken(
  doFetch: typeof fetch,
  maker: string,
  ids: Map<string, string>,
  account: string,
  bucket: string,
  label: string,
  perms: readonly Need[],
  stamp: string,
): Promise<Made | { why: string }> {
  const acct = `com.cloudflare.api.account.${account}`;
  const resources: Record<Scope, Record<string, unknown>> = {
    account: { [acct]: '*' },
    zone: { [acct]: { 'com.cloudflare.api.account.zone.*': '*' } },
    bucket: { [`com.cloudflare.edge.r2.bucket.${account}_default_${bucket}`]: '*' },
  };
  const policies = (['account', 'zone', 'bucket'] as const)
    .map((scope) => ({
      effect: 'allow',
      resources: resources[scope],
      permission_groups: perms
        .filter((p) => p.scope === scope)
        .map((p) => ({ id: ids.get(p.api) })),
    }))
    .filter((p) => p.permission_groups.length > 0);
  const r = await cfCall(doFetch, maker, 'POST', '/user/tokens', {
    name: `claude-workspaces CI ${label} ${stamp}`,
    policies,
  });
  if (!r.ok) return { why: r.why };
  const { id, value } = (r.result ?? {}) as { id?: unknown; value?: unknown };
  return typeof id === 'string' && id && typeof value === 'string' && value
    ? { id, value }
    : { why: 'Cloudflare made a token but did not return its id and value' };
}
