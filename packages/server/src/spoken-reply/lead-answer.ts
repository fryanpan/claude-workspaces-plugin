/**
 * The lead's answer to a spoken request, said on the page that asked.
 *
 * "What's the status", "go research ferry fares": the router writes these to
 * the board's voice queue and says "On it." The lead answers through
 * `answer_voice` (MCP) → `POST /workspaces/<ws>/voice-queue/<id>/answer`, and
 * the socket the question came from says the answer, the same way it says
 * one of its own.
 *
 * Held in memory for `LEAD_ANSWER_WINDOW_MS`: an answer is worth saying aloud
 * while the speaker is still around, and a research answer takes minutes.
 *
 * The wait belongs to the person, not to the socket. Following somebody or
 * tapping a link loads another page, which opens a socket of its own, and a
 * phone drops its socket when it sleeps. So a closed socket's waits are kept
 * under the person it spoke for (`orphan`), and the next socket that person
 * opens on the same board takes them over (`adopt`), with an answer that
 * arrived in between, which is said as soon as it does. An answer nobody comes
 * back for lapses with its wait; the route has written it into the lead chat
 * by then. A socket that spoke for nobody drops its waits, and the route tells
 * the lead the answer reached nobody.
 */
import { type SpokenAnswer, shapedAnswer } from './answer.ts';
import { withoutCues } from './cues.ts';

/** How long a request waits for the lead. Long enough for a research request
 *  to come back while the board is still open. */
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

interface Waiting {
  workspaceId: string;
  say: Say;
  at: number;
  owner: object;
  from?: string;
  /** The person a closed socket spoke for, while its waits wait for their
   *  next socket. */
  heir?: string;
  /** An answer that came while no socket held the wait. */
  held?: { answer: SpokenAnswer; text: string };
}

export class LeadAnswers {
  private waiting = new Map<string, Waiting>();

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
      workspaceId,
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

  /** The socket went, speaking for `heir`: its waits are kept for the next
   *  page that person opens. With no heir, they are dropped. */
  orphan(owner: object, heir: string | null): void {
    if (heir === null) {
      this.drop(owner);
      return;
    }
    for (const w of this.waiting.values()) if (w.owner === owner) w.heir = heir;
  }

  /**
   * A socket opened for `heir` on `workspaceId`: it takes over every wait a
   * closed socket of theirs left there. `rebind` is told each old owner
   * first, so the say it holds can point at the new socket; then an answer
   * that came in between is said.
   */
  adopt(workspaceId: string, heir: string, owner: object, rebind: (old: object) => void): void {
    this.prune();
    for (const [k, w] of this.waiting) {
      if (w.heir !== heir || w.workspaceId !== workspaceId) continue;
      rebind(w.owner);
      w.owner = owner;
      w.heir = undefined;
      if (!w.held) continue;
      this.waiting.delete(k);
      w.say(w.held.answer, w.held.text);
    }
  }

  /**
   * Say the lead's answer on the socket that asked, with its `minute` for a
   * meeting's notes when it gave one. Only `text` is said; `written`, when
   * given, is what the chat shows instead. False when no open socket
   * is waiting for it — closed, expired, never asked from a spoken socket, an
   * id from another board, or a turn addressed to an agent other than `by`.
   * True for a socket closed under a person: the answer is held for the next
   * socket they open.
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
    if (!w || !words || w.held) return false;
    if (w.from !== undefined && w.from !== by) return false;
    const kept = minute?.trim();
    // The chat shows words: a tone cue is for the voice alone (`cues.ts`).
    const shown = written?.trim() || withoutCues(words);
    const answer = { ...shapedAnswer(words, LEAD_ANSWER_ROUTE), ...(kept ? { minute: kept } : {}) };
    if (w.heir !== undefined) {
      w.held = { answer, text: shown };
      return true;
    }
    this.waiting.delete(key);
    w.say(answer, shown);
    return true;
  }

  private prune(): void {
    const now = this.now();
    for (const [k, w] of this.waiting) {
      if (now - w.at > LEAD_ANSWER_WINDOW_MS) this.waiting.delete(k);
    }
  }
}
