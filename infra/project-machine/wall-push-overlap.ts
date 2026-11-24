/**
 * The daily wall report's row on push repos two projects share (wall L3).
 * `machines.ts` refuses a repo two entries list unless both declare the
 * share; this checks the machines themselves, from each one's
 * `git-push.json` as the probe read it (`machine-facts.ts`), so a policy set
 * by hand, or a deploy older than the check, shows the next day.
 *
 * A repo two machines push to passes only when every project pushing to it
 * lists it in `sharePushRepos`.
 */
import type { MachineFacts } from './machine-facts.ts';
import type { Machine } from './machines.ts';
import type { Row } from './wall-drift.ts';

const CHECK = 'push repo is this project’s alone';

export function pushOverlapRows(
  machines: readonly Machine[],
  pushes: ReadonlyMap<string, MachineFacts['gitPush']>,
): Row[] {
  const reposOf = new Map([...pushes].map(([p, g]) => [p, new Set(g.rules.map((r) => r.repo))]));
  const shares = (p: string, repo: string) =>
    machines.find((m) => m.project === p)?.sharePushRepos?.includes(repo) === true;
  const rows: Row[] = [];
  for (const [project, repos] of reposOf) {
    let alone = true;
    for (const repo of [...repos].sort()) {
      const others = [...reposOf].filter(([p, r]) => p !== project && r.has(repo)).map(([p]) => p);
      if (others.length === 0) continue;
      alone = false;
      const declared = [project, ...others].every((p) => shares(p, repo));
      rows.push({
        project,
        check: CHECK,
        answer: declared
          ? `${repo}, shared with ${others.join(', ')} as machines.json declares`
          : `${repo}, also pushed to by ${others.join(', ')}`,
        ok: declared,
      });
    }
    if (alone) rows.push({ project, check: CHECK, answer: 'yes', ok: true });
  }
  return rows;
}
