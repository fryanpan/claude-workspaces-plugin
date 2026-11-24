/**
 * The daily wall report's rows on each project's lead (wall-off review H2):
 * which listed Claude token it runs on, by label, against the pins in
 * `machines.json`, and whether Remote Control is on where the file does not
 * allow it. The facts come from the machine probe (`machine-facts.ts`).
 *
 * A label run by two projects fails unless both pin it with
 * `shareLeadToken`, so a sign-in shared by hand, or by a deploy older than the
 * pins, shows the next day.
 */
import type { MachineFacts } from './machine-facts.ts';
import type { Machine } from './machines.ts';
import type { Row } from './wall-drift.ts';

type Lead = MachineFacts['lead'];

const OLD = 'not reported: the machine runs an image older than this check';

export function leadRows(
  machines: readonly Machine[],
  leads: ReadonlyMap<string, Lead | undefined>,
): Row[] {
  const rows: Row[] = [];
  const entry = (p: string) => machines.find((m) => m.project === p);
  for (const [project, lead] of leads) {
    if (!lead) {
      rows.push({ project, check: 'lead sign-in', answer: OLD, ok: false });
      rows.push({ project, check: 'Remote Control', answer: OLD, ok: false });
      continue;
    }
    const own = entry(project);
    const label = lead.tokenLabel;
    if (label === null || label === '') {
      rows.push({
        project,
        check: 'lead sign-in',
        answer: label === null ? 'no lead started' : "the org's own approval",
        ok: true,
      });
    } else {
      const others = [...leads]
        .filter(([p, l]) => p !== project && l?.tokenLabel === label)
        .map(([p]) => p);
      const pinned = own?.leadToken === label;
      const shared =
        others.length === 0 ||
        (own?.shareLeadToken === true && others.every((p) => entry(p)?.shareLeadToken === true));
      const notes = [
        ...(pinned ? [] : ['which machines.json does not pin here']),
        ...(others.length ? [`also run by ${others.join(', ')}`] : []),
      ];
      rows.push({
        project,
        check: 'lead sign-in',
        answer: notes.length ? `${label}, ${notes.join('; ')}` : label,
        ok: pinned && shared,
      });
    }
    const allowed = own?.remoteControl === true;
    rows.push({
      project,
      check: 'Remote Control',
      answer: !lead.remoteControl
        ? 'off'
        : allowed
          ? 'on, as machines.json allows'
          : 'on, and machines.json does not allow it',
      ok: !lead.remoteControl || allowed,
    });
  }
  return rows;
}
