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
  parseContext(raw: unknown): VoiceContext | undefined;
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

export class SpokenReplyRelay {
  private readonly sessions = new WeakMap<SpokenWs, SpokenSession>();
  /** Which socket waits for which lead answer. */
  private readonly leads: LeadAnswers;

  constructor(private readonly deps: SpokenReplyRelayDeps) {
    this.leads = deps.leads ?? new LeadAnswers();
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
              session.sayLead(queueId, a);
            },
            from,
          ),
        conversation,
      ),
      timings: this.deps.timings,
      ...(this.deps.agentCallbacks ? { agentCallbacks: this.deps.agentCallbacks } : {}),
      provenActor,
      readOnly: ws.data.readOnly === true,
      parseContext: this.deps.parseContext,
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
    session.open();
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
    if (session) this.leads.drop(session);
    this.sessions.delete(ws);
  }

  /** The lead's answer to a spoken request: said on the socket or into the
   *  bot meeting that asked, or false when none is waiting for it. `by` is the
   *  answering agent: a turn addressed to one agent takes only its answer. */
  answerRequest(
    workspaceId: string,
    queueId: string,
    text: string,
    minute?: string,
    by?: string,
  ): boolean {
    return this.leads.answer(workspaceId, queueId, text, minute, by);
  }
}
