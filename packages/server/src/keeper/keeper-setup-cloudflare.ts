/**
 * The Cloudflare half of `keeper-setup.ts`: the permissions the keeper's
 * token needs, making that token with the current one, and the account id.
 *
 * The list is the union of what the callers through the keeper use:
 * sharing (Access applications), `machine:deploy` (the Access reads and the
 * named tunnel, `docs/process/project-machine.md`), `router:deploy` (zone,
 * DNS, certificates, routes, `infra/board-router-worker/README.md`) and
 * `access:apply` (`infra/access-apps/README.md`). The new token gets no
 * API Tokens permission: the keeper refuses every token write anyway, and a
 * token that cannot make tokens cannot be turned into a wider one.
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

export interface CfPermission {
  /** As the dashboard's Create Custom Token page names it. */
  dashboard: string;
  /** As `GET /user/tokens/permission_groups` names it. */
  api: string;
  scope: 'account' | 'zone';
}

const perm = (group: string, level: 'Edit' | 'Read', scope: CfPermission['scope']) => ({
  dashboard: `${group} ${level}`,
  api: `${group} ${level === 'Edit' ? 'Write' : 'Read'}`,
  scope,
});

export const CF_TOKEN_PERMISSIONS: readonly CfPermission[] = [
  perm('Access: Apps and Policies', 'Edit', 'account'),
  perm('Access: Apps and Policies', 'Read', 'account'),
  perm('Access: Organizations, Identity Providers, and Groups', 'Read', 'account'),
  perm('Access: Service Tokens', 'Read', 'account'),
  perm('Cloudflare Tunnel', 'Edit', 'account'),
  perm('Workers Scripts', 'Edit', 'account'),
  perm('Zone', 'Read', 'zone'),
  perm('DNS', 'Edit', 'zone'),
  perm('SSL and Certificates', 'Read', 'zone'),
  perm('Workers Routes', 'Edit', 'zone'),
];

/** What to make in the dashboard when the current token cannot make one. */
export function manualTokenSteps(): string[] {
  const of = (scope: CfPermission['scope']) =>
    CF_TOKEN_PERMISSIONS.filter((p) => p.scope === scope).map((p) => `       - ${p.dashboard}`);
  return [
    'Make the token in the dashboard: My Profile > API Tokens > Create Token > Custom token.',
    '   Name it "claude-workspaces keeper". Give it these permissions:',
    '     Account (Account Resources: Include, your account):',
    ...of('account'),
    '     Zone (Zone Resources: Include, All zones from your account):',
    ...of('zone'),
    '   Leave out every API Tokens permission. Create it and copy it.',
  ];
}

type Cf = { success?: boolean; result?: unknown; errors?: { message?: string }[] };

async function cfCall(
  doFetch: typeof fetch,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; result: unknown } | { ok: false; why: string }> {
  try {
    const res = await doFetch(`${CF_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Cf;
    if (res.ok && json.success) return { ok: true, result: json.result };
    const said = json.errors?.[0]?.message;
    return { ok: false, why: `${method} ${path} answered ${res.status}${said ? `: ${said}` : ''}` };
  } catch (err) {
    return { ok: false, why: `${method} ${path} failed: ${(err as Error).message}` };
  }
}

/** The one account the token sees. A token that sees none or several is an error. */
export async function oneAccount(
  doFetch: typeof fetch,
  token: string,
): Promise<{ id: string } | { why: string }> {
  const r = await cfCall(doFetch, token, 'GET', '/accounts');
  if (!r.ok) return { why: r.why };
  const ids = Array.isArray(r.result)
    ? r.result.map((a) => (a as { id?: unknown }).id).filter((id) => typeof id === 'string')
    : [];
  if (ids.length !== 1)
    return { why: `the token sees ${ids.length} accounts; it must see exactly one` };
  return { id: ids[0] as string };
}

/**
 * Make the keeper's token with the current one, which needs User API Tokens
 * Edit. Any refusal returns the reason, and the caller falls back to the
 * dashboard.
 */
export async function mintKeeperToken(
  doFetch: typeof fetch,
  current: string,
  date: string,
): Promise<{ token: string } | { why: string }> {
  const account = await oneAccount(doFetch, current);
  if ('why' in account) return account;
  const groups = await cfCall(doFetch, current, 'GET', '/user/tokens/permission_groups');
  if (!groups.ok) return { why: groups.why };
  const byName = new Map<string, string>();
  for (const g of Array.isArray(groups.result) ? groups.result : []) {
    const { id, name } = g as { id?: unknown; name?: unknown };
    if (typeof id === 'string' && typeof name === 'string') byName.set(name, id);
  }
  const missing = CF_TOKEN_PERMISSIONS.filter((p) => !byName.has(p.api)).map((p) => p.api);
  if (missing.length) return { why: `Cloudflare lists no permission named ${missing.join(', ')}` };
  const ids = (scope: CfPermission['scope']) =>
    CF_TOKEN_PERMISSIONS.filter((p) => p.scope === scope).map((p) => ({ id: byName.get(p.api) }));
  const acct = `com.cloudflare.api.account.${account.id}`;
  const made = await cfCall(doFetch, current, 'POST', '/user/tokens', {
    name: `claude-workspaces keeper ${date}`,
    policies: [
      { effect: 'allow', resources: { [acct]: '*' }, permission_groups: ids('account') },
      {
        effect: 'allow',
        resources: { [acct]: { 'com.cloudflare.api.account.zone.*': '*' } },
        permission_groups: ids('zone'),
      },
    ],
  });
  if (!made.ok) return { why: made.why };
  const value = (made.result as { value?: unknown } | undefined)?.value;
  return typeof value === 'string' && value
    ? { token: value }
    : { why: 'Cloudflare made a token but did not return its value' };
}
