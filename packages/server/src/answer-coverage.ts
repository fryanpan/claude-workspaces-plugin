import type { ReviewPayload, TaskReviewItem } from '@claude-workspaces/core';
/**
 * Did an answer cover every question a review item asks? The network half,
 * and the rules for when it is asked at all.
 *
 * An item asking three things, answered on the first, used to close — and
 * the other two waited on the reader with nothing on the reader's queue
 * (2026-09-14). Now an answer to an item that asks more than one question is
 * checked first; one that leaves questions open is recorded as a PARTIAL
 * answer, the item stays on the queue naming what is left, and answering the
 * rest closes it.
 *
 * Same split and the same rules as `review-judge.ts`:
 *
 *  - **The key is the dedicated summary key** (`resolveKeyFrom`): prod's item
 *    on the prod service, the eval item on every other process. An item's
 *    words and the reader's answer are the same class of board content the
 *    judge already sends.
 *  - **Every failure closes the item**, exactly as an answer did before this
 *    check existed: no key, a timeout, a non-2xx, a reply that will not
 *    parse. Logged once per process per cause.
 *  - **Asked only when it can matter**: a typed answer (a tapped option
 *    answers the item it was offered for), on an item whose words ask two or
 *    more questions (`questionsAsked`), that is not a secret ask and not an
 *    item filed for a done-when owner line.
 *
 * `createServer` takes this as an option with NO default — the seam rule:
 * nothing that merely spins a server up can reach the network.
 */
import {
  type AnswerCoverageItem,
  buildAnswerCoveragePrompt,
  parseAnswerCoverageResponse,
  questionsAsked,
  standingPartials,
} from '@claude-workspaces/core/answer-coverage-prompt';
import { readRenamedEnv } from '@claude-workspaces/core/env-names';
import { readKeychainPassword } from './share/keychain.ts';
import { resolveKeyFrom } from './summarize.ts';

export interface AnswerCoverageInput {
  item: AnswerCoverageItem;
  /** Every answer so far, oldest first, the new one last. */
  answers: string[];
}

/** The seam. `null` (or a throw) means "could not tell" — the answer closes. */
export type AnswerCoverage = (input: AnswerCoverageInput) => Promise<{ open: string[] } | null>;

const MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
/** Every question with the words that answer it, as JSON. A reply cut off
 *  here fails to parse and the answer closes the item, so err high. */
const MAX_TOKENS = 1_500;
/** A person pressed Send and is waiting on this; past it, the answer closes. */
export const ANSWER_COVERAGE_TIMEOUT_MS = 6_000;

export interface HaikuAnswerCoverageOpts {
  fetchImpl?: typeof fetch;
  /** Supply a key directly instead of reading Keychain (tests). */
  apiKey?: string | null;
  timeoutMs?: number;
}

const warned = new Set<string>();
function warnOnce(cause: string, line: string): void {
  if (warned.has(cause)) return;
  warned.add(cause);
  console.error(line);
}

/** `CW_ANSWER_COVERAGE=0` turns the check off; answers close items as before. */
export function answerCoverageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readRenamedEnv(env, 'CW_ANSWER_COVERAGE') !== '0';
}

/** The real check, or `null` when there is no key or it is switched off. */
export function haikuAnswerCoverage(opts: HaikuAnswerCoverageOpts = {}): AnswerCoverage | null {
  if (!answerCoverageEnabled()) return null;
  const key = resolveKeyFrom(opts.apiKey, readKeychainPassword);
  if (!key) return null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? ANSWER_COVERAGE_TIMEOUT_MS;
  return async (input) => {
    const { system, user } = buildAnswerCoveragePrompt(input.item, input.answers);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        warnOnce(`http-${res.status}`, `[answer-coverage] HTTP ${res.status}; answers close items`);
        return null;
      }
      const body = (await res.json()) as { content?: Array<{ text?: string }> };
      const text = body.content?.map((b) => b.text ?? '').join('') ?? '';
      const verdict = parseAnswerCoverageResponse(text);
      if (!verdict)
        warnOnce('unparseable', '[answer-coverage] reply was not a verdict; answer closed');
      return verdict;
    } catch (err) {
      warnOnce(
        'call-failed',
        `[answer-coverage] call failed (${err instanceof Error ? err.message : String(err)}); answers close items`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Whether an answer to this item is checked at all. The item-side rules; the
 * caller adds its own (a done-when owner line, the ticket's own decision).
 */
export function coverageApplies(review: ReviewPayload, answeredWith: string | undefined): boolean {
  if (answeredWith !== undefined) return false;
  if (review.shape === 'secret') return false;
  return questionsAsked(review) >= 2;
}

type CoveredItem = Pick<TaskReviewItem, 'review' | 'partialAnswers' | 'revisions' | 'answer'>;

/** What a verdict was reached against: the wording and the answers so far. */
function coverageStamp(item: CoveredItem): string {
  return `${item.revisions?.length ?? 0}:${item.partialAnswers?.length ?? 0}:${item.answer ? 1 : 0}`;
}

/**
 * The questions this answer leaves open — `[]` when it closes the item.
 *
 * Judged together with the item's standing partial answers, oldest first, so
 * a second answer that covers the rest closes it. Answers given before the
 * item's last revision are left out: they answered words that are gone.
 *
 * `reread` returns the item as it stands after the call. The call takes up to
 * six seconds; if the item was revised or answered again meanwhile, the
 * verdict describes a state that is gone, so the check runs once more against
 * the item as it now stands. The caller writes synchronously after this
 * returns, so nothing can change in between.
 *
 * `[]` for every failure too: no check wired, a judge that answers `null`, a
 * judge that throws, an item still changing on the second try. That is the
 * fail-open rule — the answer closes the item, as it did before the check
 * existed.
 */
export async function openPartsAfter(
  coverage: AnswerCoverage | undefined,
  item: CoveredItem,
  text: string,
  reread: () => CoveredItem | undefined = () => item,
  retries = 1,
): Promise<string[]> {
  if (!coverage) return [];
  const { review } = item;
  const before = coverageStamp(item);
  const earlier = standingPartials(item.partialAnswers, item.revisions?.at(-1)?.at);
  let verdict: { open: string[] } | null;
  try {
    verdict = await coverage({
      item: {
        headline: review.headline,
        ...(review.detail !== undefined ? { detail: review.detail } : {}),
        ...(review.options ? { options: review.options.map((o) => ({ label: o.label })) } : {}),
      },
      answers: [...earlier.map((p) => p.text), text],
    });
  } catch (err) {
    warnOnce(
      'threw',
      `[answer-coverage] check threw (${err instanceof Error ? err.message : String(err)}); answer closed`,
    );
    return [];
  }
  const now = reread();
  if (now && coverageStamp(now) === before) return verdict?.open ?? [];
  if (!now || now.answer || retries <= 0) return [];
  return openPartsAfter(coverage, now, text, reread, retries - 1);
}
