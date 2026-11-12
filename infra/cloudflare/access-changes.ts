/**
 * Who a saved plan adds to or removes from each project's Access sign-in
 * list, read from `terraform show -json <plan>`.
 *
 * `modules/access/main.tf` marks each `people` policy's `include` sensitive,
 * so the plan text prints `(sensitive value)` where the addresses are. The
 * JSON form still carries the values, so the keeper reads them here and puts
 * them on the `cf:sync-config` approval page, and nowhere else: never the requester's answer,
 * a log line or a board artifact (`keeper-cf-sync.ts`).
 */

interface PolicyChange {
  type?: string;
  name?: string;
  mode?: string;
  index?: unknown;
  change?: { actions?: string[]; before?: unknown; after?: unknown };
}

/** One project's sign-in list, as this plan changes it. */
export interface AccessChange {
  /** The project label: the policy's key in `var.projects`. */
  project: string;
  added: string[];
  removed: string[];
}

/** One include rule as a person reads it: an address, a whole domain, or the raw rule. */
function ruleText(rule: unknown): string {
  const r = (rule ?? {}) as Record<string, { email?: unknown; domain?: unknown } | null>;
  if (typeof r.email?.email === 'string') return r.email.email;
  if (typeof r.email_domain?.domain === 'string') return `anyone at @${r.email_domain.domain}`;
  // Not a shape the module writes: show it whole rather than drop it.
  const set = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null));
  return `rule ${JSON.stringify(set)}`;
}

/** The rules a side of the change holds (none for a side that does not exist), or null when terraform did not say. */
function rulesOf(side: unknown): string[] | null {
  if (side === null || side === undefined) return [];
  const include = (side as { include?: unknown }).include;
  if (!Array.isArray(include)) return null;
  return include.map(ruleText);
}

/**
 * Each project whose sign-in list the plan changes, sorted by label.
 * Throws when a `people` policy the plan creates or changes has a list the
 * JSON does not hold, because a page that showed nothing there would read
 * as "nobody added".
 */
export function accessChanges(showJson: string): AccessChange[] {
  const plan = JSON.parse(showJson) as { resource_changes?: PolicyChange[] };
  const out: AccessChange[] = [];
  for (const rc of plan.resource_changes ?? []) {
    if (rc.mode === 'data') continue;
    if (rc.type !== 'cloudflare_zero_trust_access_policy' || rc.name !== 'people') continue;
    const actions = rc.change?.actions ?? [];
    if (actions.length === 0 || actions.every((a) => a === 'no-op' || a === 'read')) continue;
    const project = typeof rc.index === 'string' ? rc.index : JSON.stringify(rc.index ?? null);
    const before = rulesOf(rc.change?.before);
    // A delete's `after` is null: everyone on the list is removed.
    const after = rulesOf(rc.change?.after);
    if (before === null || after === null) {
      throw new Error(`the plan does not say who can sign in to ${project}`);
    }
    const added = after.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !after.includes(x));
    if (added.length || removed.length) out.push({ project, added, removed });
  }
  return out.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
}
