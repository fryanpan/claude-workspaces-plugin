import { type BoardDestination, TITLE_FLOOR, TITLE_MARGIN, rankTitles } from './voice-resolve.ts';
/**
 * Voice quick actions: what the board mic does on the page, at once, with no
 * agent. Bryan, 2026-10-02: a matcher in front of an agent that gets
 * everything else "seems too primitive", and the spoken replies were too long.
 *
 *  - open a task, doc or mockup from a loose description (the router's title
 *    index, `voice.ts`);
 *  - go somewhere, including another board ("take me to the Riverbend
 *    board"), which is `boardAsk` here;
 *  - start a plan or a meeting (`startAsk`), the board's own two buttons;
 *  - leave feedback about the app (`feedbackAsk`), onto the one doc every
 *    board's feedback widget writes to;
 *  - say what voice can do (`helpAsk`).
 *
 * Everything else is a request for the lead agent. The detectors here catch
 * the common phrasings with no model; the choice classifier
 * (`voice-choice.ts`) offers the same actions as options, so a looser
 * phrasing is matched by meaning.
 *
 * Every ack here is six words or fewer and never says how it was routed: the
 * page already shows what was heard, and what happened is the whole reply.
 */
import { capWords } from './voice-status.ts';

export type StartKind = 'plan' | 'meeting';

export type QuickAction =
  | { kind: 'board'; workspaceId: string }
  | { kind: 'place'; place: BoardDestination }
  | { kind: 'start'; start: StartKind }
  | { kind: 'feedback' }
  | { kind: 'help' };

/** Another board the speaker may be taken to. */
export interface OtherBoard {
  id: string;
  name: string;
}

/** The longest quick-action ack, in words, as it is spoken. */
export const QUICK_ACK_MAX_WORDS = 6;

/** What the agent route says. Never "sent to the agent": the speaker asked
 *  for something, and the reply is that it is being done. */
export const AGENT_ACK = 'On it.';
/**
 * The first plugin release whose sessions have `answer_voice`. A lead on an
 * older bundle cannot say an answer back until its session restarts, so a
 * status question is answered by the board's brief instead, as when no lead
 * is there at all.
 */
export const ANSWER_VOICE_SINCE = '0.1.279';

/** Nobody is on the board to do it yet; the request is kept. */
export const QUEUED_ACK = 'Saved for later.';

export const HELP_SPOKEN = 'Say open, go to, or start.';
export const HELP_DETAIL: readonly string[] = [
  'Open a task, doc or mock: “open the winter plan”.',
  'Go somewhere: “take me home”, “switch to another board by name”.',
  'Start: “make a plan”, “have a meeting”.',
  'Feedback on the app: “feedback: the mic is hard to find”.',
  'Anything else is done for you: “what’s the status?”, “go research ferry fares”.',
];

/** `Opening <name>.`, the name cut so the whole ack stays inside the cap. */
export function openingAck(name: string): string {
  return `Opening ${capWords(name.replace(/["“”]/g, ''), QUICK_ACK_MAX_WORDS - 1)}.`;
}

export const START_ACK: Record<StartKind, string> = {
  plan: 'Starting a plan.',
  meeting: 'Starting a meeting.',
};
export const FEEDBACK_SAVED_ACK = 'Thanks, feedback saved.';
export const FEEDBACK_ASK = 'What’s the feedback?';

/**
 * Where a start lands: the board itself, with the kind in the query. The board
 * mic was the one reader, and it was removed on 2026-10-30, so today the
 * board ignores the query and a pasted link starts nothing.
 */
export function startPath(workspaceId: string, start: StartKind): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}?start=${start}`;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ASK_PREFIX =
  "(?:(?:hey |ok |okay |so )?(?:i(?:'d| would)? (?:want|like|need) to |can you |could you |can we |could we |please |let's |lets |i want to ))?";

const HELP_PATTERNS: readonly RegExp[] = [
  /^(?:help|voice help|help me)$/,
  /^what (?:can|could|should|do) (?:i|we) (?:do|say|ask)(?: here| with (?:this|you|voice|the mic|the microphone|voice commands?|commands?))?$/,
  /^what (?:can|could) you do(?: for me| here)?$/,
  /^(?:what|which) (?:are )?(?:the )?(?:voice )?commands?(?: (?:are there|can i (?:say|use)|do you (?:know|understand)))?$/,
  /\bvoice commands?\b/,
  /^how (?:do i|does (?:this|voice)|can i) (?:use|work)(?: (?:this|voice|the mic|you))?$/,
];

/** "what can I do with voice commands", "help". */
export function helpAsk(transcript: string): boolean {
  const s = normalize(transcript);
  return HELP_PATTERNS.some((p) => p.test(s));
}

const START_VERBS = '(?:start|begin|kick off|have|run|hold|do|make|create|set up|new)';
const ARTICLES = '(?:(?:a|an|the|new|another|my|our|quick) )*';
const PLAN_NOUNS = '(?:plan|planning session|planning huddle|planning|huddle)';
const MEETING_NOUNS = '(?:meeting|meeting notes|discussion|conversation)';
const PLAN_START = new RegExp(
  `^${ASK_PREFIX}(?:${START_VERBS} ${ARTICLES}${PLAN_NOUNS}|plan)(?: (?:now|right now|here)| (?:for|about|on|to) .+)?$`,
);
const MEETING_START = new RegExp(
  `^${ASK_PREFIX}${START_VERBS} ${ARTICLES}${MEETING_NOUNS}(?: (?:now|right now|here))?$`,
);

/** "make a plan", "let's have a meeting" — the board's two start buttons. */
export function startAsk(transcript: string): StartKind | null {
  const s = normalize(transcript);
  if (MEETING_START.test(s)) return 'meeting';
  if (PLAN_START.test(s)) return 'plan';
  return null;
}

const FEEDBACK_PREFIX =
  /^(?:(?:product|app|workspace|board) )?feedback(?: (?:about|on|for) (?:the |this )?(?:workspaces?|app|board|product|tool|ui|interface))?\s*[:,.\-–—]\s*(.*)$/i;
const FEEDBACK_VERB =
  /^(?:i(?:'d| would)? (?:want|like) to |can i |let me )?(?:leave|give|send|file|add|submit|record) (?:some |a bit of |a piece of |my )?(?:product |app )?feedback(?: (?:about|on|for) (?:the |this )?(?:workspaces?|app|board|product|tool|ui|interface|voice))?(?:\s*[:,.\-–—]\s*|\s+(?:that|saying)\s+|\s*$)(.*)$/i;

/**
 * "feedback: the mic is hard to find" → the words after the prefix; "I want
 * to leave feedback" → empty (the router asks for it). Null when the
 * utterance is not feedback. The words are a slice of the transcript.
 */
export function feedbackAsk(transcript: string): { body: string } | null {
  const t = transcript.trim().replace(/[’]/g, "'");
  const m = FEEDBACK_PREFIX.exec(t) ?? FEEDBACK_VERB.exec(t);
  if (!m) return null;
  return { body: (m[1] ?? '').trim() };
}

const BOARD_WORD = /\b(?:board|workspace|project)s?\b/;
const SWITCH_OPENER = new RegExp(
  `^${ASK_PREFIX}(?:(?:go |head |jump |get )?back to|go to|go into|go over to|head(?: over)? to|take me(?: over| back)? to|bring me to|jump(?: over)? to|navigate to|switch(?: over)? to|change to|move to|open(?: up)?|show(?: me)?|pull up|see)\\s+(.+)$`,
);

/** A board name as words compared without plurals or possessives: "the Team
 *  Lead's board" and "Team Leads workspace" both read "team lead". */
function boardWords(name: string): string {
  return normalize(name)
    .replace(/'s\b/g, '')
    .replace(/'/g, '')
    .split(' ')
    .filter((w) => w && !['the', 'my', 'our', 'board', 'workspace', 'project'].includes(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .join(' ');
}

/**
 * "take me to the Riverbend board" → that board, when exactly one board's
 * name fits and the speaker said "board", "workspace" or "project". A name
 * with none of those words is left to the title index and the model: it is
 * as likely to be a doc.
 */
export function boardAsk(
  transcript: string,
  boards: readonly OtherBoard[],
): { kind: 'hit'; board: OtherBoard } | null {
  const m = SWITCH_OPENER.exec(normalize(transcript));
  const name = m?.[1];
  if (!name || !BOARD_WORD.test(name) || boards.length === 0) return null;
  const query = boardWords(name);
  if (!query) return null;
  const ranked = rankTitles(
    query,
    boards.map((b) => ({ id: b.id, kind: 'doc' as const, title: boardWords(b.name) })),
  );
  const [best, second] = ranked;
  if (!best || best.score < TITLE_FLOOR) return null;
  if (second && second.score >= TITLE_FLOOR && best.score - second.score < TITLE_MARGIN) {
    return null;
  }
  const board = boards.find((b) => b.id === best.id);
  return board ? { kind: 'hit', board } : null;
}

/** Whether a spoken reply is short enough for a quick action. */
export function quickAckFits(spoken: string): boolean {
  return spoken.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length <= QUICK_ACK_MAX_WORDS;
}
