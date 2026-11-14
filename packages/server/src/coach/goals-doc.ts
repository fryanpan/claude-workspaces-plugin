/**
 * The learning-goals doc: the template the coach starts it from, and the
 * reading of it the coach judges against.
 *
 * The doc is filled in by the planning voice's goals interview
 * (`spoken-reply/interview-goals.ts`): tap Talk on the doc and it asks the
 * coach's name and what the owner wants to do better, then writes whatever
 * is said about any goal where it belongs. So the template is only headings, and
 * the goals heading's exact words are what mark a doc as a goals doc.
 *
 * The goals live in one section, "What I want to do better". Each top-level
 * bullet (with its sub-bullets) or paragraph there is one goal, and carries
 * its own trigger: "If I spend more than an hour on X, ask me Y." He asked
 * for no more structure than that (the owner, 2026-10-05).
 *
 * Docs made before that have one `##` section per goal with four `###`
 * parts. They still read: every "What I want to do better" item is a goal,
 * with its section's "Act differently when" joined to it, and a section
 * with only a trigger is a goal of its own.
 */

export const NAME_HEADING = 'Your coach’s name';
export const GOALS_HEADING = 'What I want to do better';
/** The four-part layout's trigger, still read. */
const TRIGGER_HEADING = 'Act differently when';

export interface LearningGoal {
  /** What he wrote, trigger included. A moment must quote words from it. */
  text: string;
}

export interface GoalsDocReading {
  name?: string;
  /** In doc order; a moment names one by its 1-based place here. */
  goals: LearningGoal[];
}

const NAME_CHARS = 40;
const GOAL_CHARS = 600;

export function goalsDocTemplate(): string {
  return `# Learning goals\n\nTap Talk and your coach asks its name, then what you want to do better. Say as many goals as you like, each with when it should speak up. You can type here too.\n\n## ${NAME_HEADING}\n\n## ${GOALS_HEADING}\n`;
}

/** Curly and straight apostrophes, case and spacing all read as one. */
const norm = (s: string) => s.replace(/[’']/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

/** "Let's call it Sage." → "Sage". A bare name is taken as it is. */
export function nameFrom(text: string): string | undefined {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  const said = line.match(
    /\b(?:call(?:ed)?(?: it| you| my coach| them)?|name(?: it)? is|be)\s+(.+)$/i,
  );
  const name = (said?.[1] ?? line)
    .replace(/^[-*>\s]+/, '')
    .replace(/[.!?"“”]+$/g, '')
    .replace(/^["“]/, '')
    .trim();
  if (!name) return undefined;
  return name.split(/\s+/).slice(0, 3).join(' ').slice(0, NAME_CHARS);
}

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;

const bodyText = (lines: string[]): string =>
  lines
    .map((l) => l.replace(BULLET, '').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, GOAL_CHARS);

/** One goal per top-level bullet, sub-bullets and wrapped lines kept with
 *  it, and one per paragraph. */
function goalItems(lines: string[]): string[] {
  const items: string[][] = [];
  let item: string[] | null = null;
  let gap = false;
  for (const line of lines) {
    if (!line.trim()) {
      gap = true;
      continue;
    }
    const topLevel = line.length - line.trimStart().length < 2;
    if (!item || (topLevel && (gap || BULLET.test(line)))) {
      item = [];
      items.push(item);
    }
    item.push(line);
    gap = false;
  }
  return items.map(bodyText).filter(Boolean);
}

/** One `##` section: its goal items and, in the four-part layout, its trigger. */
interface Section {
  items: string[];
  trigger: string;
  /** "## What I want to do better" itself: any sub-heading stays in it. */
  goalsOnly: boolean;
}

/** The doc as the coach reads it. Headings it does not know are skipped. */
export function readGoalsDoc(markdown: string): GoalsDocReading {
  const reading: GoalsDocReading = { goals: [] };
  const sections: Section[] = [];
  let section: Section | null = null;
  let part: 'name' | 'goals' | 'trigger' | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (part === 'name') {
      const n = nameFrom(bodyText(lines));
      if (n) reading.name = n;
    } else if (part === 'goals' && section) section.items.push(...goalItems(lines));
    else if (part === 'trigger' && section) section.trigger = bodyText(lines);
    lines = [];
  };
  for (const line of markdown.split('\n')) {
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!h) {
      if (part) lines.push(line);
      continue;
    }
    flush();
    const level = h[1]?.length ?? 0;
    const text = norm(h[2] ?? '');
    if (level <= 2) {
      section = null;
      part = null;
      if (level === 1) continue;
      if (text === norm(NAME_HEADING)) {
        part = 'name';
        continue;
      }
      const goalsOnly = text === norm(GOALS_HEADING);
      section = { items: [], trigger: '', goalsOnly };
      sections.push(section);
      if (goalsOnly) part = 'goals';
    } else if (section) {
      if (text === norm(GOALS_HEADING) || section.goalsOnly) part = 'goals';
      else part = text === norm(TRIGGER_HEADING) ? 'trigger' : null;
    }
  }
  flush();
  const goal = (text: string): LearningGoal => ({ text: text.slice(0, GOAL_CHARS) });
  reading.goals = sections.flatMap((s) => {
    if (s.items.length === 0) return s.trigger ? [goal(s.trigger)] : [];
    return s.items.map((i) => goal(s.trigger ? `${i}\n${s.trigger}` : i));
  });
  return reading;
}

/** A goal's one-line title, for the card. */
export function goalTitle(goal: LearningGoal): string {
  const t = (goal.text.split('\n')[0] ?? '').trim();
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}
