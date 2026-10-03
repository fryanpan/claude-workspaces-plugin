/**
 * The learning-goals doc: the template the coach starts it from, and the
 * reading of it the coach judges against.
 *
 * The doc is filled in by the planning interview (`spoken-reply/
 * interview.ts`): tap Talk on the doc and it asks about each empty section
 * and writes the spoken answer under its heading. So the template is only
 * headings. The interview asks the most important empty section first,
 * scoring heading words like "goals" and "why" above the rest, so every
 * heading here avoids those words: with equal scores it asks in the doc's
 * order, and the coach's name comes first.
 *
 * Each goal is one `##` section with four `###` parts. The doc may hold any
 * number; "Add a goal" appends `goalSection(n)`. A goal the coach can act on
 * has both "What I want to do better" and "Act differently when" filled in.
 */

export const NAME_HEADING = 'Your coach’s name';

export const PARTS = [
  { key: 'what', heading: 'What I want to do better' },
  { key: 'behind', heading: 'What’s behind it' },
  { key: 'when', heading: 'Act differently when' },
  { key: 'how', heading: 'How' },
] as const;
export type PartKey = (typeof PARTS)[number]['key'];

export interface LearningGoal {
  /** The section heading as he left it ("Goal 1" or his own words). */
  heading: string;
  what: string;
  behind: string;
  /** The moment to watch for. A moment must quote words from this. */
  when: string;
  how: string;
}

export interface GoalsDocReading {
  name?: string;
  goals: LearningGoal[];
}

const NAME_CHARS = 40;
const PART_CHARS = 600;

export function goalSection(n: number): string {
  return `## Goal ${n}\n\n${PARTS.map((p) => `### ${p.heading}\n`).join('\n')}`;
}

export function goalsDocTemplate(): string {
  return `# Learning goals\n\nTap Talk and your coach asks about each empty section, starting with its name. You can type here too.\n\n## ${NAME_HEADING}\n\n${goalSection(1)}`;
}

/** Curly and straight apostrophes, case and spacing all read as one. */
const norm = (s: string) => s.replace(/[’']/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

const PART_BY_HEADING = new Map(PARTS.map((p) => [norm(p.heading), p.key]));

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

const bodyText = (lines: string[]): string =>
  lines
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, PART_CHARS);

/** The doc as the coach reads it. Headings it does not know are skipped. */
export function readGoalsDoc(markdown: string): GoalsDocReading {
  const reading: GoalsDocReading = { goals: [] };
  let nameLines: string[] | null = null;
  let goal: LearningGoal | null = null;
  let part: PartKey | null = null;
  let partLines: string[] = [];
  const flushPart = () => {
    if (goal && part) goal[part] = bodyText(partLines);
    part = null;
    partLines = [];
  };
  const flushName = () => {
    if (nameLines) {
      const n = nameFrom(bodyText(nameLines));
      if (n) reading.name = n;
    }
    nameLines = null;
  };
  for (const line of markdown.split('\n')) {
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!h) {
      if (nameLines) nameLines.push(line);
      else if (part) partLines.push(line);
      continue;
    }
    const level = h[1]?.length ?? 0;
    const text = h[2] ?? '';
    flushPart();
    flushName();
    if (level === 2) {
      goal = null;
      if (norm(text) === norm(NAME_HEADING)) {
        nameLines = [];
        continue;
      }
      goal = { heading: text, what: '', behind: '', when: '', how: '' };
      reading.goals.push(goal);
    } else if (level === 3 && goal) {
      part = PART_BY_HEADING.get(norm(text)) ?? null;
    }
  }
  flushPart();
  flushName();
  reading.goals = reading.goals.filter((g) => g.what || g.behind || g.when || g.how);
  return reading;
}

/** Goals the coach may act on: what to do better, and when. */
export function actionableGoals(reading: GoalsDocReading): LearningGoal[] {
  return reading.goals.filter((g) => g.what && g.when);
}

/** A goal's one-line title for the front page and the card. */
export function goalTitle(goal: LearningGoal): string {
  const first = (goal.what.split('\n')[0] ?? '').trim();
  const t = first || goal.heading;
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}
