/**
 * The daily wall report's drift checks: what each project machine, its Fly
 * app and Cloudflare are set to, against what the deploy and the config say
 * they should be. Pure: `wall-report.ts` reads, this judges. Each row says
 * matches, differs or is missing, and never prints an address, audience or
 * key. It reports drift; nothing here changes anything.
 *
 * Why a daily check at all: `machine:deploy` never sets a secret that already
 * exists, so a changed Access audience, a widened CW_PROXIED_TRUSTED_EMAILS
 * or a hand-set `fly secrets` value would otherwise drift with nobody told.
 */
import { WALL_PROBE } from '../../packages/server/src/provisioning/move-steps.ts';
import type { StaticVars } from '../cloudflare/vars.ts';
import type { MachineFacts } from './machine-facts.ts';
import { SETTING_NAMES } from './settings.ts';

export const PROBE = WALL_PROBE;
export const appFor = (project: string): string => `cw-${project}`;

/** The last JSON line of a command's output; `fly ssh` prints its own lines first. */
export function lastJson<T>(out: string): T {
  const line = out
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error('no JSON in the probe output');
  return JSON.parse(line) as T;
}

export interface Row {
  project: string;
  check: string;
  answer: string;
  ok: boolean;
}

const row = (project: string, check: string, answer: string, ok: boolean): Row => ({
  project,
  check,
  answer,
  ok,
});

const nameOf = (x: { Name?: string; name?: string }) => x.Name ?? x.name ?? '';

export interface FlyView {
  apps: Array<{ Name?: string; name?: string; Network?: string; network?: string }>;
  /** `fly ips list --json` per app. */
  ips: Record<string, Array<{ Type?: string; type?: string }>>;
  /** `fly machine list --json` per app. */
  machines: Record<string, Array<{ id?: string; config?: { services?: unknown[] } }>>;
}

/**
 * Each app on its own network, named after itself, with nothing published.
 * Every other app on that network counts, listed project or not (wall L2).
 */
export function flyRows(projects: readonly string[], view: FlyView): Row[] {
  const rows: Row[] = [];
  const networkOf = new Map(view.apps.map((a) => [nameOf(a), a.Network ?? a.network]));
  const appsOn = (net: string, not: string) =>
    [...networkOf].filter(([a, n]) => a !== not && n === net).map(([a]) => a);
  for (const p of projects) {
    const app = `cw-${p}`;
    if (!networkOf.has(app)) {
      rows.push(row(p, 'Fly app', `${app} not in fly apps list`, false));
      continue;
    }
    const net = networkOf.get(app);
    const shared = net ? appsOn(net, app) : [];
    rows.push(
      row(
        p,
        'Fly network',
        !net
          ? 'Fly did not name it'
          : shared.length
            ? `${net}, shared with ${shared.join(', ')}`
            : net,
        net === app && shared.length === 0,
      ),
    );
    const publicIps = (view.ips[app] ?? [])
      .map((i) => i.Type ?? i.type ?? 'unknown')
      .filter((t) => !t.startsWith('private'));
    rows.push(
      row(
        p,
        'no public address',
        publicIps.length ? `public: ${publicIps.join(', ')}` : 'none',
        publicIps.length === 0,
      ),
    );
    const serving = (view.machines[app] ?? []).filter((m) => (m.config?.services ?? []).length > 0);
    rows.push(
      row(
        p,
        'no Fly service',
        serving.length ? `services on ${serving.map((m) => m.id ?? '?').join(', ')}` : 'none',
        serving.length === 0,
      ),
    );
  }
  return rows;
}

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/**
 * The server's admission settings against what `machine:deploy` would set
 * (`settings.ts`), and its trusted emails against the owner alone.
 */
export function settingsRows(
  project: string,
  expected: ReadonlyMap<string, string>,
  facts: MachineFacts,
): Row[] {
  const s = facts.server;
  if (!s) return [row(project, 'board server', 'no server process found', false)];
  const rows: Row[] = [];
  for (const name of SETTING_NAMES) {
    const want = expected.get(name);
    const have = s[name];
    if (want === undefined) {
      rows.push(row(project, name, 'no source to compare with', false));
    } else if (have === undefined) {
      rows.push(row(project, name, 'not set on the server', false));
    } else {
      const same =
        name === 'CW_PROXIED_TRUSTED_HOSTS'
          ? list(have).sort().join(',') === list(want).sort().join(',')
          : have.trim() === want.trim();
      rows.push(row(project, name, same ? 'matches' : 'differs from the deploy', same));
    }
  }
  const owner = (expected.get('CW_OWNER_EMAIL') ?? '').trim().toLowerCase();
  const trusted = list(s.CW_PROXIED_TRUSTED_EMAILS);
  const extra = trusted.filter((e) => e !== owner).length;
  rows.push(
    row(
      project,
      'CW_PROXIED_TRUSTED_EMAILS',
      trusted.length === 0
        ? 'unset, so the owner alone'
        : extra
          ? `${extra} address(es) besides the owner`
          : 'the owner alone',
      extra === 0,
    ),
  );
  const skips = s.CW_LOOPBACK_SKIPS_ACCESS;
  rows.push(row(project, 'CW_LOOPBACK_SKIPS_ACCESS', skips ?? 'unset', skips === '1'));
  return rows;
}

/**
 * The loopback uid door admits `cw` alone as the operator, and the tunnel
 * alone through the edge (security review M3): root, the lead, the backup
 * upload and any builder are refused. An empty allowed list turns the door off.
 */
export function uidRows(project: string, facts: MachineFacts): Row[] {
  if (!facts.server) return [];
  const names = new Map(facts.users.map((u) => [u.uid, u.name]));
  names.set(0, 'root');
  const named = (uids: number[]) =>
    uids.map((uid) => `${names.get(uid) ?? 'uid'} ${uid}`).join(', ');
  const only = (uids: number[], user: string) => {
    const want = facts.users.find((u) => u.name === user)?.uid;
    return want !== undefined && uids.length > 0 && uids.every((uid) => uid === want);
  };
  const allowed = list(facts.server.CW_LOOPBACK_ALLOWED_UIDS ?? '').map(Number);
  const edge = list(facts.server.CW_LOOPBACK_EDGE_UIDS ?? '').map(Number);
  return [
    row(
      project,
      'loopback admits cw alone',
      allowed.length ? named(allowed) : 'off: every uid is admitted',
      only(allowed, 'cw'),
    ),
    row(
      project,
      'loopback admits the tunnel alone through the edge',
      edge.length ? named(edge) : 'nobody',
      edge.length === 0 || only(edge, 'cwtunnel'),
    ),
  ];
}

/**
 * Which repos a board may push to, and whether every push waits. Approval
 * is opt-in (`git-push/policy.ts`), so a repo that pushes without it is the
 * intended state, not drift; a `.github/` change waits either way.
 */
export function gitPushRows(project: string, facts: MachineFacts): Row[] {
  const g = facts.gitPush;
  if (g.state === 'absent') return [row(project, 'git-push.json', 'absent: no push allowed', true)];
  if (g.state === 'unparseable')
    return [row(project, 'git-push.json', 'does not parse: the server allows no push', false)];
  if (g.rules.length === 0) return [row(project, 'git-push.json', 'no repo listed', true)];
  return g.rules.map((r) =>
    row(
      project,
      `git push ${r.repo}`,
      `board ${r.board}: ${r.approval ? 'waits for approval' : 'pushes without approval; a .github/ change waits'}`,
      true,
    ),
  );
}

/** GitHub's deploy keys for one repo, or null when they could not be read. */
export type RepoKeys = Array<{ key: string; read_only: boolean }> | null;

/** The repos to look for the lead's deploy key on. */
export function deployKeyRepos(facts: MachineFacts): string[] {
  return [...new Set([...facts.repos, ...facts.gitPush.rules.map((r) => r.repo)])].sort();
}

export function deployKeyRows(
  project: string,
  facts: MachineFacts,
  keys: Record<string, RepoKeys>,
): Row[] {
  if (!facts.deployKey) return [row(project, 'deploy key', 'the lead has none', true)];
  const want = facts.deployKey;
  const unread = Object.entries(keys)
    .filter(([, k]) => k === null)
    .map(([r]) => r);
  for (const [repo, k] of Object.entries(keys)) {
    const hit = k?.find((x) => x.key.trim().split(/\s+/).slice(0, 2).join(' ') === want);
    if (hit)
      return [
        row(
          project,
          'deploy key is read-only',
          `${repo}: ${hit.read_only ? 'read-only' : 'can write'}`,
          hit.read_only,
        ),
      ];
  }
  const repos = Object.keys(keys);
  return [
    row(
      project,
      'deploy key is read-only',
      repos.length === 0
        ? 'no repo to look on'
        : `not found on ${repos.join(', ')}${unread.length ? ` (could not read ${unread.join(', ')})` : ''}`,
      false,
    ),
  ];
}

export interface Ingress {
  ingress?: Array<{ hostname?: string; service?: string }>;
}

/** cloudflared runs the named tunnel, whose ingress sends only the project's host to the server. */
export function ingressRows(
  project: string,
  publicHost: string | undefined,
  config: Ingress | null,
  facts: MachineFacts,
): Row[] {
  const rows = [row(project, 'cloudflared', facts.cloudflared, facts.cloudflared === 'named')];
  if (!publicHost)
    return [...rows, row(project, 'tunnel ingress', 'no tunnel in the outputs', false)];
  if (!config) return [...rows, row(project, 'tunnel ingress', 'could not be read', false)];
  const rules = config.ingress ?? [];
  const [first, last] = [rules[0], rules[rules.length - 1]];
  const ok =
    rules.length === 2 &&
    first?.hostname === publicHost &&
    first.service === 'http://localhost:8787' &&
    !last?.hostname &&
    (last?.service ?? '').startsWith('http_status:404');
  return [
    ...rows,
    row(
      project,
      'tunnel ingress',
      ok ? 'its host to the server, the rest 404' : `${rules.length} rule(s), not the expected two`,
      ok,
    ),
  ];
}

type RouterVars = Pick<StaticVars, 'project_origins' | 'board_origins' | 'one_address_origin'>;

/** With more than one origin, the one address must name its own (review M2). */
export function oneAddressRows(v: RouterVars): Row[] {
  const origins = new Set([...Object.values(v.project_origins), ...Object.keys(v.board_origins)]);
  const set = v.one_address_origin !== '';
  const ok = set ? origins.has(v.one_address_origin) : origins.size <= 1;
  return [
    row(
      '(all)',
      'ONE_ADDRESS_ORIGIN',
      set
        ? origins.has(v.one_address_origin)
          ? 'set to one of the origins'
          : 'set to an origin the tables do not list'
        : `unset with ${origins.size} origin(s)`,
      ok,
    ),
  ];
}

/** No service token admitted by two projects' Access applications. */
export function serviceTokenRows(access: StaticVars['access_projects']): Row[] {
  const seen = new Map<string, string[]>();
  for (const [p, a] of Object.entries(access))
    for (const t of a.service_tokens) seen.set(t, [...(seen.get(t) ?? []), p]);
  const shared = [...seen].filter(([, ps]) => ps.length > 1);
  return shared.length
    ? shared.map(([t, ps]) =>
        row('(all)', "service token is one project's", `${t}: ${ps.join(', ')}`, false),
      )
    : [
        row(
          '(all)',
          "each service token is one project's",
          `${seen.size} token(s), none shared`,
          true,
        ),
      ];
}

/**
 * A plan against the live account: no change means the Access applications
 * and policies, tunnel ingress and router Worker (its ONE_ADDRESS_ORIGIN
 * binding included) are what the config says.
 */
export function planRows(status: number, summary: string): Row[] {
  if (status !== 0)
    return [row('(all)', 'Cloudflare matches the config', 'the plan did not run', false)];
  if (summary.includes('No changes.'))
    return [row('(all)', 'Cloudflare matches the config', 'the plan has no changes', true)];
  const changes = summary.split('\n').filter((l) => l.startsWith('- '));
  return changes.map((l) => row('(all)', 'Cloudflare drifted from the config', l.slice(2), false));
}

/** A GitHub Environment as the report reads it: names and times only, never a value. */
export interface GithubEnvironment {
  name: string;
  /** Its secrets' names and update times, or null when they could not be read. */
  secrets: Array<{ name: string; updated_at?: string }> | null;
  /** Deployments from main alone: custom branch policies, one rule `main`. Null when unread. */
  mainOnly: boolean | null;
}

export interface GithubView {
  /** Every environment of the repo, or null when the list could not be read. */
  environments: GithubEnvironment[] | null;
  /** The repository's own secret names, or null when unread. */
  repoSecrets: string[] | null;
}

/** A cut token older than this missed a monthly `fly:ci-tokens apply`; it expires at 90. */
export const CI_TOKEN_STALE_DAYS = 45;

/**
 * The one environment that holds the Fly org token, by design since the
 * keeper retired (docs/process/keeper.md, "Retired"):
 * deployments from main only, used by fly-provision.yml, fly-ci-tokens.yml
 * and wall-read.yml.
 */
export const ORG_TOKEN_ENVIRONMENT = 'fly-org';

/**
 * The Fly org token is in `fly-org` and nowhere else in CI (wall-off review
 * M5): no other environment and no repository secret is named
 * FLY_API_TOKEN. And each app CI deploys has its
 * own environment (H1), admitting main alone, holding FLY_DEPLOY_TOKEN cut
 * within CI_TOKEN_STALE_DAYS (`ci-tokens.ts`).
 */
export function ciTokenRows(
  envs: ReadonlyArray<{ project: string; environment: string }>,
  view: GithubView,
  nowMs: number,
): Row[] {
  const holders = [
    ...(view.repoSecrets?.includes('FLY_API_TOKEN') ? ['the repository'] : []),
    ...(view.environments ?? [])
      .filter(
        (e) =>
          e.name !== ORG_TOKEN_ENVIRONMENT && e.secrets?.some((s) => s.name === 'FLY_API_TOKEN'),
      )
      .map((e) => e.name),
  ];
  const unread =
    view.environments === null ||
    view.repoSecrets === null ||
    view.environments.some((e) => e.secrets === null);
  const rows = [
    row(
      '(all)',
      `no Fly org token in GitHub outside ${ORG_TOKEN_ENVIRONMENT}`,
      holders.length
        ? `FLY_API_TOKEN in ${holders.join(', ')}`
        : unread
          ? 'not every secret list could be read'
          : 'none',
      holders.length === 0 && !unread,
    ),
  ];
  for (const { project, environment } of envs) {
    const e = view.environments?.find((x) => x.name === environment);
    const check = `${environment} environment`;
    if (!view.environments) {
      rows.push(row(project, check, 'could not be read', false));
      continue;
    }
    if (!e) {
      rows.push(row(project, check, 'missing: run bun run fly:ci-tokens apply', false));
      continue;
    }
    const token = e.secrets?.find((s) => s.name === 'FLY_DEPLOY_TOKEN');
    const age = token?.updated_at
      ? Math.floor((nowMs - Date.parse(token.updated_at)) / 86_400_000)
      : null;
    const answer =
      e.mainOnly !== true
        ? e.mainOnly === null
          ? 'its branch rule could not be read'
          : 'admits a branch other than main'
        : !e.secrets
          ? 'its secrets could not be read'
          : !token
            ? 'holds no FLY_DEPLOY_TOKEN'
            : age === null || Number.isNaN(age)
              ? 'FLY_DEPLOY_TOKEN has no update time'
              : age > CI_TOKEN_STALE_DAYS
                ? `FLY_DEPLOY_TOKEN is ${age} days old; the monthly fly:ci-tokens apply did not run`
                : `main alone, FLY_DEPLOY_TOKEN ${age} day(s) old`;
    rows.push(
      row(
        project,
        check,
        answer,
        e.mainOnly === true && token !== undefined && age !== null && age <= CI_TOKEN_STALE_DAYS,
      ),
    );
  }
  return rows;
}

/** One Access application as Cloudflare's API lists it, policies inline. */
export interface LiveAccessApp {
  name?: string;
  policies?: Array<{ decision?: string; include?: Array<Record<string, unknown>> }>;
}

/**
 * Each project's live Access application admits only whom the Mac's
 * `access.local.json` lists (wall-off review N1). The config is outside the
 * repo, so a merge cannot change both sides; a plan alone could not catch a
 * merge that changed how the policies are rendered. `everyone`, a bypass and
 * any include kind the config never writes are alarms. Prints counts, never
 * an address.
 */
export function liveAccessRows(
  config: StaticVars['access_projects'],
  live: LiveAccessApp[] | null,
  tokenNames: ReadonlyMap<string, string>,
  /** The environment's `name_prefix`: "" for prod, "staging " for staging. */
  prefix = '',
): Row[] {
  if (!live) return [row('(all)', 'live Access policies', 'could not be read', false)];
  const rows: Row[] = [];
  for (const [project, want] of Object.entries(config)) {
    const app = live.find((a) => a.name === `${prefix}board ${project}`);
    if (!app) {
      rows.push(row(project, 'live Access policies', 'no application', false));
      continue;
    }
    const emails = new Set(want.emails.map((e) => e.toLowerCase()));
    const domains = new Set(want.email_domains.map((d) => d.toLowerCase()));
    const tokens = new Set(want.service_tokens.map((t) => `${prefix}${t}`));
    const extra: string[] = [];
    let count = 0;
    for (const p of app.policies ?? []) {
      if (p.decision === 'bypass') extra.push('a bypass policy');
      for (const inc of p.include ?? []) {
        count++;
        const kind = Object.keys(inc)[0] ?? '?';
        const body = (inc[kind] ?? {}) as Record<string, unknown>;
        const listed =
          kind === 'email'
            ? emails.has(String(body.email ?? '').toLowerCase())
            : kind === 'email_domain'
              ? domains.has(String(body.domain ?? '').toLowerCase())
              : kind === 'service_token'
                ? tokens.has(tokenNames.get(String(body.token_id ?? '')) ?? '')
                : false;
        if (!listed) extra.push(kind);
      }
    }
    rows.push(
      row(
        project,
        'live Access policies',
        extra.length
          ? `admits what access.local.json does not list: ${[...new Set(extra)].join(', ')}`
          : `${count} include(s), each in access.local.json`,
        extra.length === 0,
      ),
    );
  }
  return rows;
}
