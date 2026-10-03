/**
 * "Your coach" for one front-page load, drawn with its styles. Asked only
 * for the owner's own signed-in session.
 */
import { actionableGoals, goalTitle } from './goals-doc.ts';
import type { GoalsDocReading } from './goals-doc.ts';
import { DEFAULT_COACH_NAME } from './moment.ts';
import { COACH_SECTION_CSS, renderCoachSection } from './section.ts';
import type { CoachStore } from './store.ts';

export function coachSectionFor(
  store: CoachStore,
  readGoals: () => GoalsDocReading | null,
  online: boolean,
  now: number = Date.now(),
): string {
  const doc = store.goalsDoc;
  const reading = doc ? readGoals() : null;
  const goals = reading?.goals ?? [];
  const html = renderCoachSection({
    docUrl: doc
      ? `/workspaces/${encodeURIComponent(doc.workspaceId)}/docs/${encodeURIComponent(doc.docId)}`
      : null,
    name: reading?.name ?? DEFAULT_COACH_NAME,
    online,
    goals: goals.map(goalTitle),
    unready: reading ? goals.length - actionableGoals(reading).length : 0,
    reviewDue: store.reviewDue(now),
    readiness: store.readiness,
    week: store.week(now),
  });
  return `<style>${COACH_SECTION_CSS}</style>\n${html}`;
}
