/**
 * What `bun run access:apply` would write, decided from what the account
 * already holds. Pure: `apply.ts` does the reads, hands them here, and sends
 * only the writes this returns. Tested by
 * `packages/server/test/access-apps-apply.test.ts`.
 *
 * Every refusal is decided here, before any write is sent:
 *
 * - a project host equal to, or under, a hostname an existing application
 *   covers whose name the config does not own (prod's sign-in application is
 *   never changed or shadowed);
 * - a service token name that matches no token, or more than one;
 * - an application the config owns by name that is not `self_hosted`, or two
 *   applications with that name.
 *
 * The only writes are a POST of a new `self_hosted` application and a PUT of
 * one the config owns by name. Nothing here deletes.
 */
import { type AccessAppBody, type AccessConfig, accessApps } from './access-plan.ts';

/** An Access application as the account lists it. Only the fields read here. */
export interface ExistingApp {
  id: string;
  name: string;
  type?: string;
  aud?: string;
  domain?: string;
  self_hosted_domains?: string[];
  destinations?: Array<{ uri?: string }>;
  session_duration?: string;
  app_launcher_visible?: boolean;
  http_only_cookie_attribute?: boolean;
  same_site_cookie_attribute?: string;
  policies?: Array<{ id?: string; name?: string; decision?: string; include?: unknown[] }>;
}

export interface ServiceToken {
  id: string;
  name: string;
}

export type ResolvedInclude =
  | { email: { email: string } }
  | { email_domain: { domain: string } }
  | { service_token: { token_id: string } };

/** An application body with every service token name replaced by its id. */
export interface ResolvedAppBody extends Omit<AccessAppBody, 'policies'> {
  policies: Array<{
    id?: string;
    name: string;
    decision: 'allow' | 'non_identity';
    include: ResolvedInclude[];
  }>;
}

export type Step =
  | { label: string; name: string; action: 'create' }
  | { label: string; name: string; action: 'update'; id: string; changed: string[] }
  | { label: string; name: string; action: 'unchanged'; id: string };

export interface Write {
  label: string;
  method: 'POST' | 'PUT';
  path: string;
  body: ResolvedAppBody;
}

export type Decision =
  | { ok: false; refusals: string[] }
  | { ok: true; steps: Step[]; writes: Write[] };

/** The hostnames an application covers, wildcard and path stripped. */
function coveredHosts(app: ExistingApp): string[] {
  const raw = [
    app.domain,
    ...(app.self_hosted_domains ?? []),
    ...(app.destinations ?? []).map((d) => d.uri),
  ];
  const hosts = raw
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .map((d) => (d.split('/')[0] as string).replace(/^\*\./, '').toLowerCase());
  return [...new Set(hosts)];
}

/** Each refusal a foreign application's hostnames earn against the config's hosts. */
function shadowRefusals(cfg: AccessConfig, foreign: ExistingApp[]): string[] {
  const out: string[] = [];
  for (const [label, p] of Object.entries(cfg.projects)) {
    for (const host of p.hosts) {
      for (const app of foreign) {
        for (const covered of coveredHosts(app)) {
          if (host === covered) {
            out.push(
              `${label}: ${host} is covered by the application "${app.name}", which the config does not own.`,
            );
          } else if (host.endsWith(`.${covered}`)) {
            out.push(
              `${label}: ${host} is under ${covered}, which the application "${app.name}" covers and the config does not own.`,
            );
          }
        }
      }
    }
  }
  return out;
}

/** The fields a PUT would change, in a fixed order. Policies compare by name. */
function changedFields(existing: ExistingApp, want: ResolvedAppBody): string[] {
  const policies = (ps: ExistingApp['policies']) =>
    JSON.stringify(
      (ps ?? [])
        .map((p) => ({ name: p.name, decision: p.decision, include: p.include ?? [] }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    );
  const pairs: Array<[string, unknown, unknown]> = [
    ['type', existing.type, want.type],
    ['domain', existing.domain, want.domain],
    [
      'self_hosted_domains',
      JSON.stringify(existing.self_hosted_domains ?? []),
      JSON.stringify(want.self_hosted_domains),
    ],
    ['session_duration', existing.session_duration, want.session_duration],
    ['app_launcher_visible', existing.app_launcher_visible, want.app_launcher_visible],
    [
      'http_only_cookie_attribute',
      existing.http_only_cookie_attribute,
      want.http_only_cookie_attribute,
    ],
    [
      'same_site_cookie_attribute',
      existing.same_site_cookie_attribute,
      want.same_site_cookie_attribute,
    ],
    ['policies', policies(existing.policies), policies(want.policies)],
  ];
  return pairs.filter(([, a, b]) => a !== b).map(([k]) => k);
}

/**
 * Decide every step from the account's applications and service tokens. An
 * application the config owns must be listed with its policies (the account's
 * GET of that one application), or every run reads as an update.
 */
export function decide(
  cfg: AccessConfig,
  accountId: string,
  apps: ExistingApp[],
  tokens: ServiceToken[],
): Decision {
  const bodies = accessApps(cfg);
  const owned = new Set(bodies.map((b) => b.name));
  const refusals = shadowRefusals(
    cfg,
    apps.filter((a) => !owned.has(a.name)),
  );

  const tokenId = new Map<string, string | null>();
  for (const t of tokens) tokenId.set(t.name, tokenId.has(t.name) ? null : t.id);

  const byName = new Map<string, ExistingApp[]>();
  for (const a of apps)
    if (owned.has(a.name)) byName.set(a.name, [...(byName.get(a.name) ?? []), a]);

  const labels = Object.keys(cfg.projects);
  const steps: Step[] = [];
  const writes: Write[] = [];
  const appsPath = `/accounts/${accountId}/access/apps`;
  bodies.forEach((body, i) => {
    const label = labels[i] as string;
    const matches = byName.get(body.name) ?? [];
    if (matches.length > 1) {
      refusals.push(
        `${label}: there are ${matches.length} applications named "${body.name}"; resolve that by hand.`,
      );
      return;
    }
    const existing = matches[0];
    if (existing && existing.type !== 'self_hosted') {
      refusals.push(
        `${label}: the application "${body.name}" is ${existing.type ?? 'of no type'}, not self_hosted; it is not changed here.`,
      );
      return;
    }
    const policies: ResolvedAppBody['policies'] = [];
    for (const p of body.policies) {
      const include: ResolvedInclude[] = [];
      for (const rule of p.include) {
        if (!('service_token_name' in rule)) {
          include.push(rule);
          continue;
        }
        const id = tokenId.get(rule.service_token_name);
        if (id === undefined) {
          refusals.push(`${label}: no service token is named "${rule.service_token_name}".`);
        } else if (id === null) {
          refusals.push(
            `${label}: more than one service token is named "${rule.service_token_name}".`,
          );
        } else {
          include.push({ service_token: { token_id: id } });
        }
      }
      const keep = existing?.policies?.find((e) => e.name === p.name)?.id;
      policies.push({ ...(keep ? { id: keep } : {}), name: p.name, decision: p.decision, include });
    }
    const resolved: ResolvedAppBody = { ...body, policies };
    if (!existing) {
      steps.push({ label, name: body.name, action: 'create' });
      writes.push({ label, method: 'POST', path: appsPath, body: resolved });
      return;
    }
    const changed = changedFields(existing, resolved);
    if (changed.length === 0) {
      steps.push({ label, name: body.name, action: 'unchanged', id: existing.id });
      return;
    }
    steps.push({ label, name: body.name, action: 'update', id: existing.id, changed });
    writes.push({ label, method: 'PUT', path: `${appsPath}/${existing.id}`, body: resolved });
  });

  if (refusals.length > 0) return { ok: false, refusals };
  for (const w of writes) {
    const hosts = cfg.projects[w.label]?.hosts ?? [];
    const onlyOurs =
      w.body.type === 'self_hosted' &&
      w.body.domain === hosts[0] &&
      w.body.self_hosted_domains.every((h) => hosts.includes(h));
    if (!onlyOurs)
      return { ok: false, refusals: [`${w.label}: a write would reach beyond its own hosts.`] };
  }
  return { ok: true, steps, writes };
}
