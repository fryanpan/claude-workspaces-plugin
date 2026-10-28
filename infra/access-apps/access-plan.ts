/**
 * The Cloudflare Access applications one-per-project needs, as the request
 * bodies a deploy would send. Pure: nothing here talks to Cloudflare, and
 * nothing in the repo sends these yet (README.md, "Not deployed").
 *
 * One application per project, each over that project's own hostnames, so
 * each issues stamps with an audience of its own and a stamp minted for one
 * project's application verifies on no other project's server
 * (`packages/server/src/middleware/cf-access.ts`). Tested by
 * `packages/server/test/access-apps-plan.test.ts`.
 */

/** One project, as `access.local.json` lists it. */
export interface ProjectAccess {
  /** Every hostname the project's server answers on. The first is the app's `domain`. */
  hosts: string[];
  /** People admitted one by one. */
  emails: string[];
  /** Whole email domains admitted, such as a team's Google Workspace domain. */
  emailDomains: string[];
  /** Names of the Access service tokens admitted with no identity: Home's
   *  feed token and the relay's token for this server. */
  serviceTokens: string[];
}

export interface AccessConfig {
  /** How long a sign-in lasts before Access asks again, e.g. `24h`. */
  sessionDuration: string;
  /** Project label -> its access. The label only names the application. */
  projects: Record<string, ProjectAccess>;
}

/** An `include` rule, in the shape Cloudflare's Access API takes. */
export type IncludeRule =
  | { email: { email: string } }
  | { email_domain: { domain: string } }
  /** Resolved to `{ service_token: { token_id } }` at deploy, by name. */
  | { service_token_name: string };

export interface AccessPolicy {
  name: string;
  decision: 'allow' | 'non_identity';
  include: IncludeRule[];
}

/** The body of `POST /accounts/<account>/access/apps` for one project. */
export interface AccessAppBody {
  name: string;
  type: 'self_hosted';
  domain: string;
  self_hosted_domains: string[];
  session_duration: string;
  app_launcher_visible: false;
  http_only_cookie_attribute: true;
  same_site_cookie_attribute: 'lax';
  policies: AccessPolicy[];
}

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DURATION = /^\d{1,4}h$/;
const EMAIL = /^[^@\s]+@[a-z0-9.-]+$/;
const TOKEN_NAME = /^[A-Za-z0-9 ._-]{1,128}$/;

const strings = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new Error(`${what} must be a list of strings`);
  }
  return v as string[];
};

/**
 * Read `access.local.json`. Refuses the whole file on any bad part, and on a
 * hostname listed under two projects: that host would sit under two
 * applications, and which one Cloudflare picks is not ours to decide.
 */
export function parseAccessConfig(raw: string): AccessConfig {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error('access.local.json is not JSON');
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('access.local.json must be an object');
  }
  const o = v as Record<string, unknown>;
  const sessionDuration = typeof o.sessionDuration === 'string' ? o.sessionDuration : '24h';
  if (!DURATION.test(sessionDuration)) throw new Error('sessionDuration must be hours, e.g. 24h');
  const rawProjects = o.projects;
  if (rawProjects === null || typeof rawProjects !== 'object' || Array.isArray(rawProjects)) {
    throw new Error('projects must be an object');
  }
  const projects: Record<string, ProjectAccess> = {};
  const owner = new Map<string, string>();
  for (const [label, p] of Object.entries(rawProjects)) {
    if (!LABEL.test(label)) throw new Error(`project ${label} is not a lower-case label`);
    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      throw new Error(`project ${label} must be an object`);
    }
    const r = p as Record<string, unknown>;
    const hosts = strings(r.hosts, `${label}.hosts`);
    if (hosts.length === 0) throw new Error(`project ${label} has no hosts`);
    for (const h of hosts) {
      if (!HOSTNAME.test(h)) throw new Error(`${label}: ${h} is not a lower-case hostname`);
      const prior = owner.get(h);
      if (prior) throw new Error(`${h} is listed under both ${prior} and ${label}`);
      owner.set(h, label);
    }
    const emails = strings(r.emails, `${label}.emails`);
    for (const e of emails) if (!EMAIL.test(e)) throw new Error(`${label}: an email is malformed`);
    const emailDomains = strings(r.emailDomains, `${label}.emailDomains`);
    for (const d of emailDomains) {
      if (!HOSTNAME.test(d)) throw new Error(`${label}: ${d} is not a lower-case domain`);
    }
    const serviceTokens = strings(r.serviceTokens, `${label}.serviceTokens`);
    for (const t of serviceTokens) {
      if (!TOKEN_NAME.test(t)) throw new Error(`${label}: a service token name is malformed`);
    }
    projects[label] = { hosts, emails, emailDomains, serviceTokens };
  }
  return { sessionDuration, projects };
}

/**
 * One application per project. People and whole domains share one `allow`
 * policy (Access ORs an `include` list); the service tokens get a
 * `non_identity` policy of their own, which admits a token and never a
 * person. A project with nobody listed gets no `allow` policy, so its
 * application admits no person at all rather than everyone.
 */
export function accessApps(cfg: AccessConfig): AccessAppBody[] {
  return Object.entries(cfg.projects).map(([label, p]) => {
    const people: IncludeRule[] = [
      ...p.emails.map((email) => ({ email: { email } })),
      ...p.emailDomains.map((domain) => ({ email_domain: { domain } })),
    ];
    const policies: AccessPolicy[] = [];
    if (people.length > 0)
      policies.push({ name: `${label} people`, decision: 'allow', include: people });
    if (p.serviceTokens.length > 0) {
      policies.push({
        name: `${label} service tokens`,
        decision: 'non_identity',
        include: p.serviceTokens.map((name) => ({ service_token_name: name })),
      });
    }
    return {
      name: `board ${label}`,
      type: 'self_hosted',
      domain: p.hosts[0] as string,
      self_hosted_domains: p.hosts,
      session_duration: cfg.sessionDuration,
      app_launcher_visible: false,
      http_only_cookie_attribute: true,
      same_site_cookie_attribute: 'lax',
      policies,
    };
  });
}

/**
 * `CF_ACCESS_HOST_AUDS` for one server, once the deploy has read back each
 * application's audience: every host of the projects that server runs,
 * mapped to its own application's audience.
 */
export function hostAudiencesFor(
  cfg: AccessConfig,
  labels: string[],
  audienceOf: (label: string) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const label of labels) {
    const p = cfg.projects[label];
    if (!p) throw new Error(`no project ${label}`);
    const aud = audienceOf(label);
    for (const h of p.hosts) out[h] = aud;
  }
  return out;
}
