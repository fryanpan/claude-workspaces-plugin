/**
 * The lead's answer to a spoken request, said on the page that asked.
 *
 * "What's the status", "go research ferry fares": the router writes these to
 * the board's voice queue and says "On it." The lead answers through
 * `answer_voice` (MCP) → `POST /workspaces/<ws>/voice-queue/<id>/answer`, and
 * the socket the question came from says the answer, the same way it says
 * one of its own.
 *
 * Held in memory, per socket, for `LEAD_ANSWER_WINDOW_MS`: an answer is worth
 * saying aloud while the speaker is still on the page. A socket that has
 * closed drops what it was waiting for, and the route tells the lead the
 * answer reached nobody so it can post it somewhere durable instead.
 */
import { type SpokenAnswer, shapedAnswer } from './answer.ts';

/** How long a socket keeps waiting for the lead. Long enough for a research
 *  request to come back while the board is still open. */
export const LEAD_ANSWER_WINDOW_MS = 30 * 60_000;

/** The longest answer accepted, in characters; the page writes what is not said. */
export const LEAD_ANSWER_MAX = 4000;

/** The longest written answer accepted, in characters: the fuller answer
 *  the chat shows in place of the spoken one, for a reader with it open. */
export const LEAD_WRITTEN_MAX = 8000;

/** The longest minute a lead's answer may carry, in characters: a line for
 *  a meeting's notes, not a report. */
export const LEAD_MINUTE_MAX = 300;

/** The route name a lead's answer carries on the page. */
export const LEAD_ANSWER_ROUTE = 'lead-answer';

/** `text` is the answer as the chat shows it: the written answer when the
 *  lead gave one, else the spoken answer whole, before it was shaped. */
type Say = (answer: SpokenAnswer, text: string) => void;

export class LeadAnswers {
  private waiting = new Map<string, { say: Say; at: number; owner: object; from?: string }>();

  constructor(private readonly now: () => number = Date.now) {}

  private key(workspaceId: string, queueId: string): string {
    return `${workspaceId}\0${queueId}`;
  }

  /** `owner` waits for the answer to `queueId`; `say` is how it says it.
   *  `from` names the one agent whose answer counts, for a turn addressed to
   *  it (`agent-conversation.ts`); absent, any agent on the board may answer. */
  wait(workspaceId: string, queueId: string, owner: object, say: Say, from?: string): void {
    this.prune();
    this.waiting.set(this.key(workspaceId, queueId), {
      say,
      at: this.now(),
      owner,
      ...(from !== undefined ? { from } : {}),
    });
  }

  /** The socket went: nothing it waited for can be said any more. */
  drop(owner: object): void {
    for (const [k, w] of this.waiting) if (w.owner === owner) this.waiting.delete(k);
  }

  /**
   * Say the lead's answer on the socket that asked, with its `minute` for a
   * meeting's notes when it gave one. Only `text` is said; `written`, when
   * given, is what the chat shows instead. False when no open socket
   * is waiting for it — closed, expired, never asked from a spoken socket, an
   * id from another board, or a turn addressed to an agent other than `by`.
   */
  answer(
    workspaceId: string,
    queueId: string,
    text: string,
    minute?: string,
    by?: string,
    written?: string,
  ): boolean {
    this.prune();
    const key = this.key(workspaceId, queueId);
    const w = this.waiting.get(key);
    const words = text.trim().slice(0, LEAD_ANSWER_MAX);
    if (!w || !words) return false;
    if (w.from !== undefined && w.from !== by) return false;
    this.waiting.delete(key);
    const kept = minute?.trim();
    const shown = written?.trim() || words;
    w.say({ ...shapedAnswer(words, LEAD_ANSWER_ROUTE), ...(kept ? { minute: kept } : {}) }, shown);
    return true;
  }

  private prune(): void {
    const now = this.now();
    for (const [k, w] of this.waiting) {
      if (now - w.at > LEAD_ANSWER_WINDOW_MS) this.waiting.delete(k);
    }
  }
}
