/**
 * What, of the words heard after the planning voice's question, answers it.
 *
 * In a planning meeting the person answering is also talking to the room and
 * about the tool: "oh, that was really disruptive", "having that panel open
 * is unnecessary", a sentence started and dropped. Bryan's first planning
 * meeting wrote all 67 words after a question into the plan, remarks about
 * the tool included. Only the answer belongs in the plan; the rest reaches
 * the meeting notes like any other words (`meeting-ears.ts`).
 *
 * Two passes. A false start, a clause broken off on a dash or an ellipsis
 * before a new sentence begins, is dropped without asking. Then, when the
 * server has a model, one call names which of the remaining sentences answer
 * the question, by number, so what is written is always the speaker's own
 * words and never a paraphrase. None of them: nothing is written. A model
 * that fails or answers off-format keeps every sentence but the false starts.
 *
 * The same call says whether words that answer nothing are still ABOUT the
 * question — a question back, a disagreement, thinking it through aloud — so
 * the planning voice can talk it over rather than move on
 * (`interview-discuss.ts`). That costs no second call to decide.
 */
import type { PlanComplete } from './interview-reader.ts';

export interface Clause {
  text: string;
  /** Broken off before the next clause began: a false start. */
  cut: boolean;
}

/** A sentence's end, or a dash or ellipsis breaking off before a capital. */
const BREAK = /(?:[.!?]+["'’”)\]]*|\.\.\.|…)(?=\s|$)|(?:—|–|\s--?)(?=\s+\p{Lu})/gu;
const BROKEN = /(?:\.\.\.|…|—|–|-)$/;

/** `text` as clauses, in order. A clause is cut only when another follows it. */
export function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  let last = 0;
  for (const m of text.matchAll(BREAK)) {
    const end = (m.index ?? 0) + m[0].length;
    const piece = text.slice(last, end).trim();
    if (piece) out.push({ text: piece, cut: BROKEN.test(piece) });
    last = end;
  }
  const rest = text.slice(last).trim();
  if (rest) out.push({ text: rest, cut: false });
  const tail = out.at(-1);
  if (tail) tail.cut = false;
  return out;
}

export const JUDGE_SYSTEM = [
  'A person is answering a question about their plan out loud, in a meeting.',
  'Some of what they said answers the question. Some may not: a remark about the tool, the voice,',
  'the screen or the meeting itself, an aside to someone else, or talk about something else.',
  'Reply with JSON only: {"answer": [<the numbers of the sentences that answer the question>], "discuss": <true or false>}.',
  '"answer" is [] when none of them does.',
  '"discuss" is true only when none answers it but they are talking about the question itself:',
  'asking what it means or asking you something back, disagreeing with it, or thinking it through aloud.',
  'It is false when they are unsure, or talking about something else.',
].join('\n');

export function judgePrompt(
  question: string,
  said: readonly string[],
): { system: string; user: string } {
  return {
    system: JUDGE_SYSTEM,
    user: `QUESTION: ${question}\n\nSAID:\n${said.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
  };
}

/** The judge's reply: the picked sentences as indexes into `n`, and whether
 *  the words are about the question when they pick none. Null off-format. */
export function parseVerdict(raw: string, n: number): { picks: number[]; discuss: boolean } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const m = parsed as { answer?: unknown; discuss?: unknown } | null;
  if (!Array.isArray(m?.answer)) return null;
  const picked = m.answer.filter(
    (x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= n,
  );
  const picks = [...new Set(picked)].sort((a, b) => a - b).map((x) => x - 1);
  return { picks, discuss: picks.length === 0 && m.discuss === true };
}

/** The model's picks as indexes into `n` sentences, or null off-format. */
export function parseJudge(raw: string, n: number): number[] | null {
  return parseVerdict(raw, n)?.picks ?? null;
}

/** What answers the question, and when nothing does, whether what was said
 *  is about it. With no model there is no judge, so never `discuss`. */
export interface Heard {
  answer: string;
  discuss: boolean;
}

/** The words of `heard` that answer `question` ('' when none do), and
 *  whether the rest is talk about the question. */
export async function judgeHeard(
  complete: PlanComplete | undefined,
  question: string,
  heard: string,
): Promise<Heard> {
  const kept = clauses(heard)
    .filter((c) => !c.cut)
    .map((c) => c.text);
  if (kept.length === 0 || !complete) return { answer: kept.join(' '), discuss: false };
  try {
    const v = parseVerdict(await complete(judgePrompt(question, kept)), kept.length);
    if (v) return { answer: v.picks.map((i) => kept[i]).join(' '), discuss: v.discuss };
  } catch {
    // A model that fails loses the check, not the answer.
  }
  return { answer: kept.join(' '), discuss: false };
}
