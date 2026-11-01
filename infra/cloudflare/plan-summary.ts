/**
 * What a saved plan would do, as resource addresses and verbs only, from
 * `terraform show -json <plan>`. This is what CI prints and posts to a pull
 * request: the repo is public, so its logs and comments are too, and a full
 * plan would print hostnames and the account id. Addresses carry project
 * labels and Worker names, never a hostname (routes and records are keyed by
 * label, `modules/router-worker/main.tf`) and never a value.
 */

interface ResourceChange {
  address?: string;
  mode?: string;
  change?: { actions?: string[]; importing?: unknown };
}

export type Verb = 'import' | 'add' | 'change' | 'replace' | 'destroy';

/** The verb for one resource change, or null when it changes nothing. */
export function verbOf(rc: ResourceChange): Verb | null {
  if (rc.mode === 'data') return null;
  const a = (rc.change?.actions ?? []).join(',');
  if (rc.change?.importing) return 'import';
  if (a === 'create') return 'add';
  if (a === 'update') return 'change';
  if (a === 'delete') return 'destroy';
  if (a === 'delete,create' || a === 'create,delete') return 'replace';
  return null;
}

/** Markdown: one count line, then one line per changed resource. */
export function planSummary(showJson: string, env: string): string {
  const plan = JSON.parse(showJson) as { resource_changes?: ResourceChange[] };
  const counts: Record<Verb, number> = { import: 0, add: 0, change: 0, replace: 0, destroy: 0 };
  const lines: string[] = [];
  for (const rc of plan.resource_changes ?? []) {
    const verb = verbOf(rc);
    if (!verb || typeof rc.address !== 'string') continue;
    counts[verb] += 1;
    // An import that also changes the live resource says so.
    const also =
      verb === 'import' && (rc.change?.actions ?? []).includes('update') ? ' and change' : '';
    lines.push(`- ${verb}${also} \`${rc.address}\``);
  }
  const head =
    `Cloudflare plan for ${env}: ${counts.import} to import, ${counts.add} to add, ` +
    `${counts.change} to change, ${counts.replace} to replace, ${counts.destroy} to destroy.`;
  return lines.length === 0
    ? `${head}\n\nNo changes.\n`
    : `${head}\n\n${lines.sort().join('\n')}\n`;
}
