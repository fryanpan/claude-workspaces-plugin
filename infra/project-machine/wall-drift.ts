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
import type { StaticVars } from '../cloudflare/vars.ts';
import type { MachineFacts } from './machine-facts.ts';
import { SETTING_NAMES } from './settings.ts';

export const PROBE = 'bun /app/infra/project-machine/wall-probe.ts';
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

/** Each app on its own network, named after itself, with nothing published. */
export function flyRows(projects: readonly string[], view: FlyView): Row[] {
  const rows: Row[] = [];
  const networkOf = new Map(view.apps.map((a) => [nameOf(a), a.Network ?? a.network]));
  for (const p of projects) {
    const app = `cw-${p}`;
    if (!networkOf.has(app)) {
      rows.push(row(p, 'Fly app', `${app} not in fly apps list`, false));
      continue;
    }
    const net = networkOf.get(app);
    const shared = projects.filter((o) => o !== p && net && networkOf.get(`cw-${o}`) === net);
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

/** The lead's uid must be refused over loopback; the rest are listed. */
export function uidRows(project: string, facts: MachineFacts): Row[] {
  if (!facts.server) return [];
  const raw = facts.server.CW_LOOPBACK_REFUSED_UIDS ?? '';
  const refused = new Set(list(raw).map(Number));
  const lead = facts.users.find((u) => u.name === 'lead');
  const rows = [
    row(
      project,
      'loopback refuses the lead',
      !lead
        ? 'no lead user'
        : refused.has(lead.uid)
          ? `uid ${lead.uid} refused`
          : `uid ${lead.uid} admitted`,
      !!lead && refused.has(lead.uid),
    ),
  ];
  // The door is a denylist (security review M3): say who it admits.
  const admitted = facts.users.filter((u) => u.name !== 'cw' && !refused.has(u.uid));
  rows.push(
    row(
      project,
      'loopback admits (as the operator)',
      admitted.length
        ? admitted.map((u) => `${u.name} ${u.uid}`).join(', ')
        : 'nobody but cw and root',
      true,
    ),
  );
  return rows;
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
