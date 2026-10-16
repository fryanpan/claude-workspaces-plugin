/**
 * The planning voice talking its question over instead of moving on.
 *
 * After a question, the person often talks about it rather than answering
 * it: "what do you mean by host?", "I don't think that's the right
 * question", or thinking aloud on the way to an answer. The owner, 15 Oct: "if I
 * start discussing it moves on to the next question instead of clarifying
 * and having a discussion with me." The judge (`interview-answer.ts`) says
 * when that is what happened, in the same call that picks the answer, and
 * this is the reply: ONE short spoken sentence that engages with what was
 * said — answers their question from the plan, says what the question
 * means, or narrows it. The question stays open; `interview.ts` keeps it.
 *
 * One model call, through the same `PlanComplete` the reader and the judge
 * use. A model that fails, or says nothing usable, gets no reply, and the
 * planning voice does what it did before this existed: says nothing.
 */
import type { prose } from '@claude-workspaces/core';
import { oneSentence } from './interview-phrases.ts';
import { type PlanComplete, planText } from './interview-reader.ts';

const SAID_CHARS = 2_000;

export const DISCUSS_SYSTEM = [
  'You asked a person ONE question about their plan, out loud, and they talked about the question',
  'instead of answering it: they asked you something back, disagreed with it, or thought aloud.',
  'Reply with ONE short spoken sentence, 20 words or fewer, that engages with what they said:',
  'answer their question from the plan, say what your question means, or narrow it.',
  'Stay on this question. Never ask a different one, and never repeat yours word for word.',
  'Reply with the sentence only.',
].join('\n');

export interface Discussion {
  outline: readonly prose.OutlineEntry[];
  /** The open question, as asked. */
  question: string;
  /** The plan's words it is about, when it names some. */
  quote?: string;
  /** What they said instead of an answer. */
  said: string;
}

export function discussPrompt(d: Discussion): { system: string; user: string } {
  return {
    system: DISCUSS_SYSTEM,
    user: [
      `PLAN:\n${planText(d.outline)}`,
      `YOUR QUESTION: ${d.question}`,
      ...(d.quote ? [`ABOUT THESE WORDS OF THE PLAN: ${d.quote}`] : []),
      `THEY SAID: ${d.said.trim().slice(-SAID_CHARS)}`,
    ].join('\n\n'),
  };
}

/** The one sentence said back, or '' when the model gives none. */
export async function discussReply(complete: PlanComplete, d: Discussion): Promise<string> {
  let raw: string;
  try {
    raw = await complete(discussPrompt(d));
  } catch {
    return '';
  }
  const text = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“]+|["'”]+$/g, '');
  if (!text || text.startsWith('{')) return '';
  return oneSentence(text).spoken;
}
