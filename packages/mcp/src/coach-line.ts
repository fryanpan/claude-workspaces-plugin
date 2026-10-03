/**
 * How the coach's frames read to the coach session that receives them.
 *
 * The server sends the Coach board's lead every event as it happens: what
 * the owner is reading, writing and commenting (`coach.event`), how they
 * answered a moment (`coach.answer`), and how readily they want the coach to
 * speak up (`coach.preference`). The session stays quiet unless an event
 * plainly matches a goal, and speaks through `coach_moment`; what to do with
 * each line is the `claude-workspaces:coaching` skill.
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
  thanks: 'answered "Thanks": it helped',
  'not-now': 'answered "Not now": right goal, wrong time',
  'not-this': 'answered "Not this": a wrong call',
  'moved-on': 'moved on without answering',
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

function eventLine(p: CoachPayload, timeZone?: string): string | null {
  const verb = p.kind ? VERB[p.kind] : undefined;
  if (!verb || !p.boardId) return null;
  const board = `board "${p.board ?? p.boardId}"`;
  const where = p.docId ? `"${p.doc ?? p.docId}" on ${board}` : `the page of ${board}`;
  const under = p.heading ? `, under "${p.heading}"` : '';
  const head = `[coach.event${clock(p.at, timeZone)}] The owner ${verb} ${where}${under}.`;
  return p.text ? `${head}\n${p.text}` : head;
}

/** The line for one coach frame, or null when the frame is not one. */
export function coachLine(event: string, p: CoachPayload, timeZone?: string): string | null {
  if (event === 'coach.event') return eventLine(p, timeZone);
  if (event === 'coach.answer') {
    const how = p.answer ? ANSWER[p.answer] : undefined;
    if (!how || !p.momentId) return null;
    return `[coach.answer${clock(p.at, timeZone)}] The owner ${how}. Your moment ${p.momentId} (goal: ${p.goal ?? '?'}) said: "${p.line ?? ''}". Write what it teaches you in your memory doc.`;
  }
  if (event === 'coach.preference') {
    const how = p.readiness ? READINESS[p.readiness] : undefined;
    if (!how) return null;
    return `[coach.preference${clock(p.at, timeZone)}] The owner wants you to speak up ${how}. Write it in your memory doc.`;
  }
  return null;
}
