/**
 * Does this end-of-turn message ask the owner for something?
 *
 * The board's rule is that anything needing a person exists as an answerable
 * review item before the turn ends, and chat carries a pointer only. That rule
 * has been written down for weeks and broken several times a week. The Stop
 * hook already posts every closing message to the server, so the violation is
 * visible at the moment it happens — this module is the judgment, and
 * `routes/dispatch-and-notes.ts` is where it runs.
 *
 * WHAT THIS IS, EXACTLY: a regex heuristic over prose. It has no model behind
 * it and it is wrong in both directions. A rhetorical question is not an ask
 * and this cannot always tell; an ask with no question mark and no stock
 * phrase reads as prose and is missed. The measured rates over 913 real
 * closing messages are in `docs/architecture/unfiled-ask.md`, and the surface
 * that shows the count shows them beside it — a count whose error rate is not
 * displayed is a count that will be trusted more than it has earned.
 *
 * The one design rule the whole file serves: SILENCE IS THE DEFAULT. A false
 * positive costs an agent one extra turn and the owner nothing; the cost that
 * actually matters is a detector noisy enough that people turn it off. So
 * every rule here is a conjunction — something question-shaped or
 * deferral-shaped AND addressed to the reader — and code, quotation and link
 * targets are removed before any of it runs.
 */

/** Where a `?` or a stock phrase was found, for the nudge's own words. */
export interface AskSignal {
  /** 'question' — a sentence ending in `?`; 'deferral' — a stock phrase. */
  kind: 'question' | 'deferral';
  /** The matched phrase, for the nudge line. Never the whole sentence: the
   *  nudge goes back into an agent's context and the agent has the sentence. */
  phrase: string;
}

export interface AskVerdict {
  ask: boolean;
  signals: AskSignal[];
}

/** One stock phrase, and whether the phrase IS the address. "say the word"
 *  addresses the reader on its own; "want me to" needs the sentence around it
 *  to be an offer rather than a report of one. */
interface Deferral {
  re: RegExp;
  phrase: string;
  selfAddressed?: boolean;
}

/**
 * Stock ways of handing a decision to the reader without a question mark.
 * Every one was read off real closing messages; a phrase nobody writes is a
 * rule that can only misfire. `your call`, `say the word` and `want me to`
 * are the three that carry most of the traffic.
 */
const DEFERRALS: ReadonlyArray<Deferral> = [
  { re: /\byour call\b/i, phrase: 'your call' },
  { re: /\bsay the word\b/i, phrase: 'say the word', selfAddressed: true },
  { re: /\blet me know\b/i, phrase: 'let me know', selfAddressed: true },
  { re: /\b(?:want|would you like)\s+(?:me|us)\s+to\b/i, phrase: 'want me to' },
  { re: /\bup to you\b/i, phrase: 'up to you' },
  { re: /\bone line from you\b/i, phrase: 'one line from you' },
  {
    re: /\bneeds?\s+(?:your|a)\s+(?:call|decision|answer|input|sign-?off|approval|steer|word|go-?ahead)\b/i,
    phrase: 'needs your call',
  },
  { re: /\bneed\s+from\s+you\b/i, phrase: 'need from you', selfAddressed: true },
  {
    // No name here, and none anywhere else in this file: who the owner is
    // arrives as `owners`, so the sentence gate below is what turns
    // "waiting on <a person>" into an ask and leaves "blocked on CI" alone.
    re: /\b(?:waiting|waits|blocked|pending|held)\s+(?:on|with)\b/i,
    phrase: 'waiting on you',
  },
  { re: /\bpending\s+your\b/i, phrase: 'pending your', selfAddressed: true },
  { re: /\bawait(?:ing|s)\s+your\b/i, phrase: 'awaiting your', selfAddressed: true },
  { re: /\b(?:tell|show)\s+me\s+(?:which|what|whether|if)\b/i, phrase: 'tell me which' },
  { re: /\bsay\s+(?:if|whether)\b/i, phrase: 'say if', selfAddressed: true },
  { re: /\bif you (?:disagree|object|;d rather|'d rather|prefer)\b/i, phrase: 'if you disagree' },
  { re: /\byours to (?:do|call|decide|overrule|answer|run|send)\b/i, phrase: 'yours to do' },
  { re: /\bon your queue\b/i, phrase: 'on your queue' },
  { re: /\bneeds?\s+your\b/i, phrase: 'needs your' },
  {
    re: /\b(?:decision|answer|call|approval|input|ruling|word|steer)s?\s+from\s+you\b/i,
    phrase: 'decision from you',
  },
  {
    re: /\byour\s+(?:answers?|decisions?|approval|go-?ahead|reply|replies|read|ranking|pick|sign-?off|wording pass|word)\b/i,
    phrase: 'your answer',
    selfAddressed: true,
  },
];

/**
 * Does this sentence address the READER? A question with nobody in it is
 * usually the agent thinking aloud — "what was this measured against, and is
 * that still true?" closes a paragraph about thresholds and wants no answer.
 * Two ways to be addressed: a second-person pronoun, or a first-person offer
 * that only makes sense answered ("want me to", "shall I").
 */
const ADDRESSED = /\b(?:you|your|yours)\b/i;
const OFFERED = /\b(?:want|shall|should|can|could|may|do)\s+(?:i|we|me|us)\b|\bwant\b/i;

/**
 * The two shapes that WEAR an ask's clothes without being one, both found by
 * reading the messages this misfired on:
 *
 *  - a negated wait — "Nothing there is blocked on you tonight", "Nothing
 *    else needs your input now" — which is the OPPOSITE report;
 *  - reported speech — "I told it the headline is your call" — an ask made of
 *    somebody else, quoted back.
 *
 * Both are tested on the sentence the phrase sits in, and both only ever
 * SUPPRESS: a message with a second, real ask still counts on that one.
 */
const NEGATED = /\b(?:nothing|nobody|none of|not asking)\b/i;
const REPORTED = /\b(?:I|we)(?:'ve| have)?\s+(?:told|reminded|asked|answered|relayed|reported)\b/i;

/** A fenced block, opening fence to closing fence (or to end of text). */
const FENCE_BLOCK = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|\z)/gm;
/** An inline code span. `?` inside one is a ternary, a shell `$?`, a query
 *  string or a nullish `??` — never a question. */
const CODE_SPAN = /`[^`\n]*`/g;
/** A quoted span: somebody ELSE'S question, quoted back. Straight and smart
 *  doubles only — an apostrophe makes single quotes unparseable in prose. */
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g;
/** `[text](target)` — the text is prose, the target is a locator. */
const MD_LINK = /\[([^\]\n]*)\]\([^)\n]*\)/g;
/** A bare URL left in prose. */
const BARE_URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Strip everything that is not prose addressed to the reader. Replacements
 * keep a space rather than closing up, so two sentences never merge into one.
 */
export function proseOf(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(FENCE_BLOCK, ' ')
    .replace(CODE_SPAN, ' ')
    .replace(MD_LINK, '$1')
    .replace(BARE_URL, ' ')
    .replace(QUOTED, ' ');
}

/**
 * The owner, by name, for the third person — "Waiting on Harborlight's read"
 * is the commonest way a lead writes a wait, and no second-person pronoun
 * appears in it. The names come from the BOARD (who has actually moved
 * something on it as a person) rather than from a constant, because a
 * constant would be one deployment's owner baked into a public repo.
 *
 * Null when nobody was named, which is the case every unit test that does not
 * care runs under.
 */
function ownerPattern(owners: readonly string[]): RegExp | null {
  const parts = owners
    .map((o) => o.trim())
    .filter((o) => o.length >= 2 && o.length <= 60)
    .map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return parts.length === 0 ? null : new RegExp(`\\b(?:${parts.join('|')})(?:'s|’s)?\\b`, 'i');
}

/** Sentence terminators a question can start after. */
const SENTENCE_START = /[.!?\n]/;

/**
 * The sentence ending at `end`, back to the previous terminator or the start
 * of the text — what an `ADDRESSED` test has to run over. Capped so a
 * paragraph with no punctuation cannot drag half the message in.
 */
const SENTENCE_LOOKBACK = 400;
function sentenceEndingAt(prose: string, end: number): string {
  const floor = Math.max(0, end - SENTENCE_LOOKBACK);
  let start = floor;
  for (let i = end - 1; i >= floor; i--) {
    if (SENTENCE_START.test(prose[i] as string)) {
      start = i + 1;
      break;
    }
  }
  return prose.slice(start, end);
}

/**
 * The whole sentence a deferral sits in, forward to the next terminator as
 * well as back. A question's own text ends at the `?`, but a deferral's does
 * not: "Waiting on Harborlight for the cut-shape answer" names the person
 * AFTER the phrase, and reading only as far as the match made every
 * third-person wait unaddressed.
 */
function sentenceAround(prose: string, at: number): string {
  const head = sentenceEndingAt(prose, at);
  const ceiling = Math.min(prose.length, at + SENTENCE_LOOKBACK);
  let end = ceiling;
  for (let i = at; i < ceiling; i++) {
    if (SENTENCE_START.test(prose[i] as string)) {
      end = i;
      break;
    }
  }
  return head + prose.slice(at, end);
}

/**
 * Judge one closing message.
 *
 * A question counts when its own sentence addresses the reader. A deferral
 * counts when its LINE does — the phrase is usually the address itself
 * ("your call"), but "want me to" needs the sentence around it to be an offer
 * rather than a report of one.
 */
/** Does this sentence suppress the signal in it — a negation, or somebody
 *  else's ask quoted back? */
function suppressed(sentence: string): boolean {
  return NEGATED.test(sentence) || REPORTED.test(sentence);
}

export function detectAsk(text: unknown, owners: readonly string[] = []): AskVerdict {
  if (typeof text !== 'string' || text.trim() === '') return { ask: false, signals: [] };
  const prose = proseOf(text);
  const named = ownerPattern(owners);
  const addressed = (s: string): boolean =>
    ADDRESSED.test(s) || OFFERED.test(s) || (named?.test(s) ?? false);
  const signals: AskSignal[] = [];
  for (let i = prose.indexOf('?'); i !== -1; i = prose.indexOf('?', i + 1)) {
    const sentence = sentenceEndingAt(prose, i);
    if (sentence.trim() === '') continue;
    if (suppressed(sentence)) continue;
    if (addressed(sentence)) {
      signals.push({ kind: 'question', phrase: '?' });
      break;
    }
  }
  for (const { re, phrase, selfAddressed } of DEFERRALS) {
    const m = re.exec(prose);
    if (!m) continue;
    const sentence = sentenceAround(prose, m.index + m[0].length);
    if (suppressed(sentence)) continue;
    if (selfAddressed || addressed(sentence)) {
      signals.push({ kind: 'deferral', phrase });
    }
  }
  return { ask: signals.length > 0, signals };
}

// ---------------------------------------------------------------------------
// The other half: has this session put the ask anywhere the owner reads?

/**
 * Whether an agent has an ANSWERABLE item on the board — one it filed that is
 * still open and on the owner's queue — or filed one since `since`.
 *
 * Two questions rather than one, because they close different holes. A
 * session that filed nothing this turn but has an open item is pointing at
 * that item, which is what the rule asks for ("chat carries a pointer only");
 * a session that filed one this turn has just closed the gap. Only a session
 * with neither has put the ask somewhere nobody reads.
 *
 * `createdBy` is a DISPLAY NAME, which is the one identity the hook's
 * `CW_AGENT_NAME` and a filed item both carry — compared through
 * `normalizeAgent` for the same reason the chat-audit counters are keyed that
 * way.
 */
export interface FilingState {
  /** An item this agent filed that is still open on the owner's queue. */
  openItem: boolean;
  /** An item this agent filed at or after `since`. */
  filedSince: boolean;
}

export function judgeTurnNote(
  text: unknown,
  filing: FilingState,
  owners: readonly string[] = [],
): { ask: boolean; signals: AskSignal[]; filed: boolean; nudge?: string } {
  const { ask, signals } = detectAsk(text, owners);
  const filed = filing.openItem || filing.filedSince;
  if (!ask || filed) return { ask, signals, filed };
  return { ask, signals, filed, nudge: nudgeLine(signals) };
}

/**
 * What the agent is told, inside the turn that asked. Deliberately short and
 * deliberately not an accusation: the detector is wrong about one message in
 * six (see the module header), so the line has to read sensibly when it is
 * the one in six. It names the phrase it fired on so the agent can see at a
 * glance that the reading was wrong, and says what to do when it was right.
 */
export function nudgeLine(signals: AskSignal[]): string {
  const phrases = [
    ...new Set(signals.map((s) => (s.kind === 'question' ? 'a question' : `"${s.phrase}"`))),
  ];
  return [
    `This closing message reads as an ask to the owner (${phrases.join(', ')}), and this session has no`,
    'review item open for them and filed none this turn — so the ask exists only in chat, where it dies.',
    'File it (add_review_item on the task it belongs to, or create_thread with a review payload), then',
    'close the turn with a pointer to it. If this was rhetorical and not an ask, say so in one line and',
    'end the turn — this check is a regex and it is wrong about one message in six.',
  ].join(' ');
}
