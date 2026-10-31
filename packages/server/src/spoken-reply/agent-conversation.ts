/**
 * A voice conversation with one named agent, held per converse socket.
 *
 * The page names the agent in `start` (`core/spoken-reply.ts`). Every turn
 * then skips the board's router and goes to that agent alone: a row on the
 * board's ADDRESSED comment queue first (`agent-comment-queue.ts`), so an agent
 * with no stream hears it at its next attach or heartbeat, then one frame on
 * that agent's own streams (`SseBus.sendToAgent`). No broadcast, so no other
 * agent and no page sees the words. The agent answers with `answer_voice`, the
 * answer is said on this socket (`lead-answer.ts`), and it joins the history
 * the next turn carries.
 *
 * The agent is named by its id on the socket's board and checked against that
 * board's attachments. A display name is only ever read back from the
 * server's roster, never taken from the page.
 *
 * A phone bridge reaches this the same way a page does: open
 * `WS /workspaces/<ws>/voice/converse`, send `start` with `agent`, then audio
 * or `say` frames.
 */
import type { VoiceActor } from '../voice-action.ts';
import type { VoiceContext } from '../voice-prompt.ts';

/** Turns kept per conversation: enough for the agent to follow the thread,
 *  few enough that a long talk does not grow every frame without bound. */
export const CONVERSATION_KEEP = 12;
/** The longest turn kept in the history, in characters. */
const TURN_MAX = 1000;

export interface ConversationTurn {
  from: 'owner' | 'agent';
  text: string;
}

/** What the addressed agent receives: a `voice.request` with `to` set. */
export interface AgentVoiceFrame {
  event: 'voice.request';
  workspaceId: string;
  route: 'agent' | 'agent-queued';
  /** The agent this turn is for. */
  to: string;
  transcript: string;
  /** What the speaker was told. */
  ack: string;
  /** What `answer_voice` answers. */
  queueId: string;
  conversationId: string;
  /** The turns before this one, oldest first. */
  conversation: ConversationTurn[];
  actor: { id: string; name: string; kind?: string };
  ts: number;
  /** Where the speaker was when they said it; its `link` is what the agent
   *  is shown of that. */
  context?: VoiceContext;
}

export interface AgentLine {
  /** The agent's name when it is attached to this board, else undefined. */
  attached(workspaceId: string, agentId: string): { name: string } | undefined;
  /** Write the row addressed to `frame.to`, then send the frame. How many of
   *  that agent's streams took it, or null when the row could not be written. */
  deliver(frame: AgentVoiceFrame): number | null;
}

/** Told of every turn sent and every answer kept, so the board's lead chat
 *  (`lead-chat/lead-chat.ts`) shows a spoken talk with the lead too. */
export interface AgentConversationLog {
  turn(
    workspaceId: string,
    agentId: string,
    actor: { id: string; name: string },
    transcript: string,
    queueId: string,
    queued: boolean,
  ): void;
  replied(workspaceId: string, queueId: string, text: string): void;
}

export type AgentTurn =
  | { kind: 'sent' | 'queued'; name: string; queueId: string; agentId: string }
  | { kind: 'not-attached' }
  | { kind: 'failed' };

export function sentAck(name: string): string {
  return `Sent to ${name}.`;
}

export function awayAck(name: string): string {
  return `${name} is away. I’ll pass it on when they’re back.`;
}

export class AgentConversation {
  private agent: string | undefined;
  private id = '';
  private turns: ConversationTurn[] = [];
  /** Rows sent in this conversation: only their answers join its history. */
  private asked = new Set<string>();

  constructor(
    private readonly line: AgentLine,
    private readonly workspaceId: string,
    private readonly newId: () => string,
    private readonly now: () => number = Date.now,
    private readonly log?: AgentConversationLog,
  ) {}

  /** The agent this socket talks to, or undefined for the board's router. */
  get agentId(): string | undefined {
    return this.agent;
  }

  /** Name the agent. A different one starts a new conversation. */
  address(agentId: string | undefined): void {
    if (agentId === this.agent) return;
    this.agent = agentId;
    this.id = agentId === undefined ? '' : this.newId();
    this.turns = [];
    this.asked.clear();
  }

  turn(transcript: string, actor: VoiceActor, context?: VoiceContext): AgentTurn {
    const agentId = this.agent;
    if (agentId === undefined) return { kind: 'not-attached' };
    const who = this.line.attached(this.workspaceId, agentId);
    if (!who) return { kind: 'not-attached' };
    const queueId = this.newId();
    const sent = this.line.deliver({
      event: 'voice.request',
      workspaceId: this.workspaceId,
      route: 'agent',
      to: agentId,
      transcript,
      ack: sentAck(who.name),
      queueId,
      conversationId: this.id,
      conversation: this.turns.map((t) => ({ ...t })),
      actor: { id: actor.id, name: actor.name, ...(actor.kind ? { kind: actor.kind } : {}) },
      ts: this.now(),
      ...(context ? { context } : {}),
    });
    if (sent === null) return { kind: 'failed' };
    this.remember({ from: 'owner', text: transcript });
    this.asked.add(queueId);
    this.log?.turn(
      this.workspaceId,
      agentId,
      { id: actor.id, name: actor.name },
      transcript,
      queueId,
      sent === 0,
    );
    return { kind: sent > 0 ? 'sent' : 'queued', name: who.name, queueId, agentId };
  }

  /** The agent's answer to `queueId`, kept when it belongs to this talk. */
  replied(queueId: string, text: string): void {
    if (!this.asked.delete(queueId)) return;
    this.remember({ from: 'agent', text });
    this.log?.replied(this.workspaceId, queueId, text);
  }

  private remember(t: ConversationTurn): void {
    this.turns.push({ from: t.from, text: t.text.slice(0, TURN_MAX) });
    if (this.turns.length > CONVERSATION_KEEP)
      this.turns.splice(0, this.turns.length - CONVERSATION_KEEP);
  }
}

/** The stores `agentLine` reads, as narrow as the line needs them. */
export interface AgentLineStores {
  listAttachments(workspaceId: string): ReadonlyArray<{ agentId: string }>;
  displayName(agentId: string): string | undefined;
  queueComment(
    workspaceId: string,
    item: {
      agentId: string;
      docId: string;
      event: string;
      author: { id: string; name: string };
      text: string;
      payload?: unknown;
    },
  ): string | false;
  markCommentEmitted(workspaceId: string, id: string): boolean;
  sendToAgent(
    workspaceId: string,
    agentId: string,
    frame: AgentVoiceFrame & { commentQueueId: string },
  ): number;
}

/**
 * The line over the server's own stores. The row is the record and the frame
 * is the fast path, as for a comment: the row replays verbatim at the agent's
 * next heartbeat or attach, and clears on the MCP's receipt for
 * `commentQueueId`.
 */
export function agentLine(s: AgentLineStores): AgentLine {
  return {
    attached(workspaceId, agentId) {
      if (!s.listAttachments(workspaceId).some((a) => a.agentId === agentId)) return undefined;
      return { name: s.displayName(agentId) ?? agentId };
    },
    deliver(frame) {
      const rowId = s.queueComment(frame.workspaceId, {
        agentId: frame.to,
        docId: `ws:${frame.workspaceId}`,
        event: 'voice.request',
        author: { id: frame.actor.id, name: frame.actor.name },
        text: frame.transcript,
        payload: frame,
      });
      if (rowId === false) return null;
      const sent = s.sendToAgent(frame.workspaceId, frame.to, { ...frame, commentQueueId: rowId });
      if (sent > 0) s.markCommentEmitted(frame.workspaceId, rowId);
      return sent;
    },
  };
}
