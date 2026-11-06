/**
 * The spoken-reply sockets, one `SpokenSession` each: what the websocket
 * handler hands a `kind: 'spoken'` socket's frames to.
 *
 * Built once per server from the engines `server-deps.ts` constructed (none,
 * in a test server that injects none — every setup then reads as not set up
 * and the page keeps the plain mic).
 */
import type { SpokenHeldSetups, SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { cryptoId } from '../task-fields.ts';
import { isCategoryAuthor } from '../task-owner.ts';
import type { VoiceActor } from '../voice-action.ts';
import type { VoiceContext } from '../voice-prompt.ts';
import {
  AgentConversation,
  type AgentConversationLog,
  type AgentLine,
} from './agent-conversation.ts';
import type { AgentCallbacks } from './agent-llm.ts';
import { SpokenAnswerer, type SpokenBoard } from './answer.ts';
import { SpokenInterview, type SpokenInterviewDeps } from './interview.ts';
import { LeadAnswers } from './lead-answer.ts';
import type { MeetingRoom } from './meeting-ask.ts';
import { type SpokenEngines, SpokenSession, availableSetups } from './session.ts';
import type { SpokenTimings } from './timings.ts';

export interface SpokenWs {
  data: {
    workspaceId?: string;
    readOnly?: boolean;
    /** The identity the upgrade proved, if any. */
    author?: { id: string; name: string; kind?: string } | null;
    /** The upgrade's person proof named the owner. */
    ownerProven?: boolean;
  };
  send(payload: string | Uint8Array): unknown;
}

export interface SpokenReplyRelayDeps {
  engines: SpokenEngines;
  board: SpokenBoard;
  timings: SpokenTimings;
  /** Setup 4's custom-LLM route reaches each socket's answerer through this. */
  agentCallbacks?: AgentCallbacks;
  /** `workspaceId` is the socket's board: the one a context's link may name. */
  parseContext(raw: unknown, workspaceId: string): VoiceContext | undefined;
  /** Interview mode's docs and timing record; absent, "interview me" is
   *  routed like anything else said. */
  interview?: SpokenInterviewDeps;
  /** The meeting recording on a doc, for a socket that hears it
   *  (`meeting-ears.ts`); absent, no socket can. */
  meetingEars?: (docId: string) => MeetingRoom | null;
  /** Which socket or bot meeting waits for which lead answer; shared with
   *  `meeting-claude.ts` so one answer route reaches either. */
  leads?: LeadAnswers;
  /** Where a turn addressed to one agent goes (`agent-conversation.ts`);
   *  absent, a page that names an agent is told it cannot. */
  agentLine?: AgentLine;
  /** Told of each turn to a named agent and its answer: the lead chat. */
  conversationLog?: AgentConversationLog;
  /** A fresh id for a conversation or a turn. */
  newId?: () => string;
}

/**
 * Who a socket speaks for, for handing its lead answers to the next page that
 * person opens: the proven identity, or the owner on a local page that proved
 * nobody. A read-only page or a category author speaks for nobody in
 * particular, so its waits end with it.
 */
function heirOf(ws: SpokenWs): string | null {
  const proven = ws.data.author;
  if (proven && !isCategoryAuthor(proven)) return `id:${proven.id}`;
  if (!proven && ws.data.readOnly !== true) return 'local-owner';
  return null;
}

export class SpokenReplyRelay {
  private readonly sessions = new WeakMap<SpokenWs, SpokenSession>();
  /** The sockets open now, oldest first; a WeakMap cannot be walked. */
  private readonly open = new Set<SpokenWs>();
  /** Where each session's lead answers are said: itself, until a page
   *  change hands its waits to the next session (`LeadAnswers.adopt`). */
  private readonly sayOn = new WeakMap<object, { session: SpokenSession }>();
  /** Which socket waits for which lead answer. */
  private readonly leads: LeadAnswers;

  constructor(private readonly deps: SpokenReplyRelayDeps) {
    this.leads = deps.leads ?? new LeadAnswers();
  }

  /** The session saying `session`'s answers now: itself, or the one its
   *  person's later pages handed them to. */
  private heldBy(session: SpokenSession): SpokenSession {
    let at = session;
    for (let next = this.sayOn.get(at); next; next = this.sayOn.get(at)) at = next.session;
    return at;
  }

  /** Which setups this server can run — none unless the engines were built. */
  setups() {
    return availableSetups(this.deps.engines);
  }

  /** Setups with keys but held back, and why. */
  held(): SpokenHeldSetups {
    return this.deps.engines.held ?? {};
  }

  onOpen(ws: SpokenWs): void {
    const workspaceId = ws.data.workspaceId ?? '';
    const proven = ws.data.author;
    const provenActor: VoiceActor | null =
      proven && !isCategoryAuthor(proven)
        ? { id: proven.id, name: proven.name, ...(proven.kind ? { kind: proven.kind } : {}) }
        : null;
    const send = (msg: SpokenServerMessage): void => {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // The page went; the close handler tidies up.
      }
    };
    // Only the owner talks to an agent by name: a person proof naming the
    // owner, or a local page that proved nobody on a server that lets such a
    // page write. Share and collab visitors never reach this socket.
    const owner = ws.data.ownerProven === true || (!proven && ws.data.readOnly !== true);
    const conversation =
      owner && this.deps.agentLine
        ? new AgentConversation(
            this.deps.agentLine,
            workspaceId,
            this.deps.newId ?? (() => cryptoId('vt')),
            Date.now,
            this.deps.conversationLog,
          )
        : undefined;
    const session: SpokenSession = new SpokenSession({
      engines: this.deps.engines,
      answerer: new SpokenAnswerer(
        this.deps.board,
        workspaceId,
        this.deps.interview ? new SpokenInterview(this.deps.interview, workspaceId) : undefined,
        (queueId, from) =>
          this.leads.wait(
            workspaceId,
            queueId,
            session,
            (a, text) => {
              conversation?.replied(queueId, text);
              this.heldBy(session).sayLead(queueId, a);
            },
            from,
          ),
        conversation,
      ),
      timings: this.deps.timings,
      ...(this.deps.agentCallbacks ? { agentCallbacks: this.deps.agentCallbacks } : {}),
      provenActor,
      readOnly: ws.data.readOnly === true,
      parseContext: (raw) => this.deps.parseContext(raw, workspaceId),
      ...(this.deps.meetingEars ? { meetingEars: this.deps.meetingEars } : {}),
      ownerOnPage: ws.data.ownerProven === true,
      sendJson: send,
      sendAudio: (pcm) => {
        try {
          ws.send(pcm);
        } catch {
          // As above.
        }
      },
    });
    this.sessions.set(ws, session);
    this.open.add(ws);
    session.open();
    // A page change: what this person's last page was waiting for is said here.
    const heir = heirOf(ws);
    if (heir) this.takeOver(workspaceId, heir, session);
  }

  onText(ws: SpokenWs, text: string): void {
    this.sessions.get(ws)?.onText(text);
  }

  onAudio(ws: SpokenWs, pcm: Uint8Array): void {
    this.sessions.get(ws)?.onAudio(pcm);
  }

  onClose(ws: SpokenWs): void {
    const session = this.sessions.get(ws);
    session?.close();
    const heir = heirOf(ws);
    if (session) this.leads.orphan(session, heir);
    // The next page's socket can open before the last page's has closed, when
    // its opening found nothing to take. Only a socket opened since: an older
    // one is another tab of theirs, not where they went.
    const workspaceId = ws.data.workspaceId ?? '';
    let since = false;
    let next: SpokenSession | undefined;
    for (const other of this.open) {
      if (other === ws) since = true;
      else if (since && heirOf(other) === heir && (other.data.workspaceId ?? '') === workspaceId) {
        next = this.sessions.get(other) ?? next;
      }
    }
    this.sessions.delete(ws);
    this.open.delete(ws);
    if (heir && next) this.takeOver(workspaceId, heir, next);
  }

  /** `session` takes every wait a closed socket of `heir` left on the board. */
  private takeOver(workspaceId: string, heir: string, session: SpokenSession): void {
    this.leads.adopt(workspaceId, heir, session, (old) => {
      this.sayOn.set(old, { session });
    });
  }

  /** The lead's answer to a spoken request: said on the socket or into the
   *  bot meeting that asked, or false when none is waiting for it. `by` is the
   *  answering agent: a turn addressed to one agent takes only its answer.
   *  `written` is the fuller answer the chat shows; it is never said. */
  answerRequest(
    workspaceId: string,
    queueId: string,
    text: string,
    minute?: string,
    by?: string,
    written?: string,
  ): boolean {
    return this.leads.answer(workspaceId, queueId, text, minute, by, written);
  }
}
