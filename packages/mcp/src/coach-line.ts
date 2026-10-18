/**
 * How the coach's frames read to the coach session that receives them.
 *
 * The server sends the Coach board's lead what the owner read, wrote and
 * commented as one digest per 15-minute window (`coach.digest`; a single
 * `coach.event` still reads, for a server from before digests), how they
 * answered a moment (`coach.answer`), how readily they want the coach to
 * speak up (`coach.preference`), and once a day that it is morning
 * (`coach.morning`), the one line not caused by something they did. The
 * session stays quiet unless an event plainly matches a goal, and speaks
 * through `coach_moment`; what to do with each line is the
 * `claude-workspaces:coaching` skill. A digest then lists
 * the owner's Claude Code sessions, repo and active minutes, with a line for
 * each prompt he typed and each turn end and, below it, its words in full
 * where the server had room for them, and ends with this week's plan
 * goals in plan order, or says there is no current plan. A digest that
 * waited while the session was away says how many windows it covers.
 *
 * Kept out of channel-messages.ts for the reason voice-line.ts is: the
 * wording is a decision, and this is where a test can read it.
 */

export interface CoachPayload {
  /** When it happened, ms since the epoch. */
  at?: number;
  kind?: string;
  board?: string;
  boardId?: string;
  doc?: string;
  docId?: string;
  heading?: string;
  text?: string;
  momentId?: string;
  answer?: string;
  goal?: string;
  line?: string;
  readiness?: string;
  /** A digest's window, and what happened in it. */
  from?: number;
  to?: number;
  items?: CoachDigestItem[];
  /** This week's plan goals, or the server's words for there being none. */
  plan?: { set?: string; stale?: boolean; goals?: { id?: string; title?: string }[] } | string;
  /** The morning wake-up's local day, `YYYY-MM-DD`, and its weekday. */
  day?: string;
  weekday?: string;
  /** His Claude Code time in the window, per attached session. */
  sessions?: CoachSessionMinutes[];
  /** The server's words for what the sessions list cannot see. */
  sessionsNote?: string;
  /** Windows the digest covers, when the session was away for more than one. */
  windows?: number;
  /** Windows dropped while it was away. */
  dropped?: number;
  /** The oldest marks sent with their summary only, past the server's room. */
  textDropped?: number;
}

/** One Claude Code session's line in a digest. */
export interface CoachSessionMinutes {
  boardId?: string;
  board?: string;
  repo?: string;
  minutes?: number;
  prompts?: number;
  turns?: number;
  /** What he asked and what the session answered, a few words each, and
   *  the words in full where the digest had room for them. */
  activity?: { at?: number; kind?: string; summary?: string; text?: string }[];
}

/** One line of a digest: a stay in one place, or one thing done. */
export interface CoachDigestItem {
  kind?: string;
  at?: number;
  minutes?: number;
  headings?: string[];
  boardId?: string;
  board?: string;
  docId?: string;
  doc?: string;
  heading?: string;
  text?: string;
}

const VERB: Record<string, string> = {
  view: 'is reading',
  wrote: 'wrote, in',
  comment: 'commented on',
  reply: 'replied on',
  open: 'opened',
  left: 'left',
};

const ANSWER: Record<string, string> = {
  up: 'answered thumbs up: it helped',
  down: 'answered thumbs down: it did not help',
};

const READINESS: Record<string, string> = {
  less: 'less readily: only when the match is plain',
  normal: 'as readily as before: when you see a clear match',
  more: 'more readily: also when you are less sure',
};

/** `14:05`, in `timeZone` (this machine's by default): a trigger can name
 *  minutes, and the gaps between events are the only clock the coach has. */
function clock(at: number | undefined, timeZone?: string): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '';
  const t = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }).format(at);
  return ` ${t}`;
}

const whereOf = (p: CoachDigestItem): string => {
  const board = `board "${p.board ?? p.boardId}"`;
  return p.docId ? `"${p.doc ?? p.docId}" on ${board}` : `the page of ${board}`;
};

/** `- 14:05, 12 min: read …` or `- 14:05: wrote, in …`, with any text below. */
function digestItemLine(i: CoachDigestItem, timeZone?: string): string | null {
  if (!i.boardId || !i.kind) return null;
  const t = clock(i.at, timeZone).trim();
  if (i.kind === 'view') {
    const heads = i.headings?.length ? ` (${i.headings.map((h) => `"${h}"`).join(', ')})` : '';
    return `- ${t}, ${i.minutes ?? 0} min: read ${whereOf(i)}${heads}`;
  }
  const verb = VERB[i.kind];
  if (!verb) return null;
  const under = i.heading ? `, under "${i.heading}"` : '';
  const head = `- ${t}: ${verb} ${whereOf(i)}${under}`;
  return i.text ? `${head}\n  ${i.text.replace(/\n/g, '\n  ')}` : head;
}

/** The plan's goals, numbered first to last; nothing from an older server. */
function planLines(plan: CoachPayload['plan']): string[] {
  if (plan === undefined) return [];
  if (typeof plan === 'string') return [`This week's plan: ${plan}.`];
  const goals = (plan.goals ?? []).filter((g) => g.title);
  const notes = [
    ...(plan.set ? [`set ${plan.set}`] : []),
    ...(plan.stale ? ['plan may be stale'] : []),
  ];
  const note = notes.length > 0 ? ` (${notes.join('; ')})` : '';
  return [
    `This week's plan${note}, first to last:`,
    ...goals.map((g, i) => `${i + 1}. ${g.title}${g.id ? ` (${g.id})` : ''}`),
  ];
}

/** Repo and minutes per session, then the server's note; nothing from an
 *  older server. */
function sessionLines(p: CoachPayload, timeZone?: string): string[] {
  if (p.sessions === undefined) return [];
  const lines = p.sessions.flatMap((s) => {
    if (!s.repo || !s.boardId) return [];
    const n = (count: number | undefined, one: string) =>
      `${count ?? 0} ${one}${count === 1 ? '' : 's'}`;
    const said = (s.activity ?? []).flatMap((a) =>
      a.summary
        ? [
            `  -${clock(a.at, timeZone)} ${a.kind === 'turn' ? 'session' : 'he asked'}: ${a.summary}`,
            ...(a.text && a.text !== a.summary ? [`    ${a.text.replace(/\n/g, '\n    ')}`] : []),
          ]
        : [],
    );
    return [
      `- ${s.repo}, on board "${s.board ?? s.boardId}": ${s.minutes ?? 0} min, ${n(s.prompts, 'typed prompt')}, ${n(s.turns, 'turn end')}`,
      ...said,
    ];
  });
  const head =
    lines.length > 0
      ? ['Claude Code sessions (active minutes):', ...lines]
      : ['Claude Code sessions: none counted.'];
  const cut = p.textDropped
    ? [
        `The ${p.textDropped} oldest line${p.textDropped === 1 ? '' : 's'} came without ${p.textDropped === 1 ? 'its' : 'their'} words in full: the digest had no room.`,
      ]
    : [];
  return [...head, ...cut, ...(p.sessionsNote ? [p.sessionsNote] : [])];
}

function digestLine(p: CoachPayload, timeZone?: string): string | null {
  const lines = (p.items ?? []).flatMap((i) => digestItemLine(i, timeZone) ?? []);
  const sessions = sessionLines(p, timeZone);
  if (lines.length === 0 && !(p.sessions ?? []).some((s) => s.repo && s.boardId)) return null;
  const span = `${clock(p.from, timeZone)}–${clock(p.to, timeZone).trim()}`;
  const away =
    (p.windows ?? 0) > 1 || (p.dropped ?? 0) > 0
      ? ` (held while you were away: ${p.windows ?? 1} windows${p.dropped ? `, ${p.dropped} older ones dropped` : ''})`
      : '';
  return [
    `[coach.digest${span}] What the owner did${away}:`,
    ...lines,
    ...sessions,
    ...planLines(p.plan),
  ].join('\n');
}

function eventLine(p: CoachPayload, timeZone?: string): string | null {
  const verb = p.kind ? VERB[p.kind] : undefined;
  if (!verb || !p.boardId) return null;
  const where = whereOf(p);
  const under = p.heading ? `, under "${p.heading}"` : '';
  const head = `[coach.event${clock(p.at, timeZone)}] The owner ${verb} ${where}${under}.`;
  return p.text ? `${head}\n${p.text}` : head;
}

/** The line for one coach frame, or null when the frame is not one. */
export function coachLine(event: string, p: CoachPayload, timeZone?: string): string | null {
  if (event === 'coach.digest') return digestLine(p, timeZone);
  if (event === 'coach.event') return eventLine(p, timeZone);
  if (event === 'coach.answer') {
    const how = p.answer ? ANSWER[p.answer] : undefined;
    if (!how || !p.momentId) return null;
    const wrote = p.answer === 'down' && p.text ? ` They wrote: "${p.text}".` : '';
    return `[coach.answer${clock(p.at, timeZone)}] The owner ${how}.${wrote} Your moment ${p.momentId} (goal: ${p.goal ?? '?'}) said: "${p.line ?? ''}". Write what it teaches you in your memory doc.`;
  }
  if (event === 'coach.morning') {
    if (!p.day || !p.weekday) return null;
    return `[coach.morning ${p.weekday} ${p.day}] It is morning for the owner. Check "This week's nudges" in your memory doc.`;
  }
  if (event === 'coach.preference') {
    const how = p.readiness ? READINESS[p.readiness] : undefined;
    if (!how) return null;
    return `[coach.preference${clock(p.at, timeZone)}] The owner wants you to speak up ${how}. Write it in your memory doc.`;
  }
  return null;
}
