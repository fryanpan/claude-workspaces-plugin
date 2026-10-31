/**
 * The lead chat: what a person types to a board's lead, and what the lead
 * answers, kept per board and shown live on every page of it.
 *
 * A message travels exactly as a turn addressed to one agent on the converse
 * socket does (`spoken-reply/agent-conversation.ts`): a row on the lead's
 * ADDRESSED comment queue, so a lead with no stream reads it at its next
 * attach, then one `voice.request` frame on the lead's own streams. No other
 * agent sees it. The lead answers with `answer_voice`, whose route asks this
 * module first (`answer`), so an answer that comes back an hour later still
 * lands: which question is waiting is in the log, not in a socket.
 *
 * Turns a person SAYS to the lead on a converse socket are written here too
 * (`voiceTurn`, `voiceReply`), so the chat is one conversation whether the
 * person typed or talked.
 *
 * A page is handed the latest `LEAD_CHAT_PAGE` messages and pages back from
 * there (`page`) until the first: the latest `LEAD_CHAT_KEEP` out of memory,
 * anything older off the log.
 *
 * Every change goes to the board's pages as a `lead-chat.changed` frame and
 * to no agent stream: the lead already has its own frame, and a page frame on
 * an agent's stream would cost that session a turn.
 */
import {
  LEAD_CHAT_EVENT,
  LEAD_CHAT_PAGE,
  type LeadChatCursor,
  type LeadChatFrame,
  type LeadChatHistoryPage,
  type LeadChatLead,
  type LeadChatMessage,
  type LeadChatSnapshot,
  compareLeadChatEntries,
} from '@claude-workspaces/core/lead-chat';
import {
  type AgentLine,
  type AgentVoiceFrame,
  CONVERSATION_KEEP,
  type ConversationTurn,
  sentAck,
} from '../spoken-reply/agent-conversation.ts';
import type { VoiceContext } from '../voice-prompt.ts';
import { LEAD_CHAT_KEEP, type LeadChatLog, type StoredLeadChatMessage } from './log.ts';

export interface LeadChatDeps {
  log: LeadChatLog;
  line: AgentLine;
  /** The board's lead, by id and display name; null when the seat is empty. */
  leadOf(workspaceId: string): LeadChatLead | null;
  /** Send a frame to the board's pages only. */
  broadcast(workspaceId: string, frame: LeadChatFrame): void;
  newId(): string;
  now?: () => number;
}

export type LeadChatPost =
  | { ok: true; message: LeadChatMessage }
  | { ok: false; error: 'write-failed' };

/** The longest turn the lead is handed as history, in characters. */
const HISTORY_TURN_MAX = 1000;

interface Waiting {
  workspaceId: string;
  messageId: string;
  agentId: string;
}

export class LeadChat {
  private readonly boards = new Map<string, LeadChatMessage[]>();
  /** Boards whose held list is their whole conversation, so a page back
   *  never needs the log. */
  private readonly complete = new Set<string>();
  /** queueId → the person's message it answers. Rebuilt from the log. */
  private readonly waiting = new Map<string, Waiting>();
  /** queueId → the message a spoken turn wrote, for its answer. */
  private readonly spoken = new Map<string, Waiting>();
  private readonly now: () => number;

  constructor(private readonly deps: LeadChatDeps) {
    this.now = deps.now ?? Date.now;
  }

  snapshot(workspaceId: string): LeadChatSnapshot {
    const list = this.messages(workspaceId);
    return {
      lead: this.deps.leadOf(workspaceId),
      messages: list.slice(-LEAD_CHAT_PAGE).map(publicMessage),
      more: list.length > LEAD_CHAT_PAGE || !this.complete.has(workspaceId),
    };
  }

  /**
   * The `limit` messages just before `before`, oldest first. Served from
   * memory while it reaches far enough back, else from the log; null when
   * the log could not be read.
   */
  async page(
    workspaceId: string,
    before: LeadChatCursor,
    limit: number,
  ): Promise<LeadChatHistoryPage | null> {
    const earlier = (list: readonly StoredMessage[]) =>
      list.filter((m) => compareLeadChatEntries(m, before) < 0);
    let older = earlier(this.messages(workspaceId));
    if (older.length <= limit && !this.complete.has(workspaceId)) {
      const all = await this.deps.log.history(workspaceId);
      if (!all) return null;
      older = earlier(all);
    }
    return { messages: older.slice(-limit).map(publicMessage), more: older.length > limit };
  }

  /** A person's message, typed or dictated on the page: recorded, then sent
   *  to the lead. */
  post(
    workspaceId: string,
    author: { id: string; name: string },
    text: string,
    context?: VoiceContext,
    via: 'chat' | 'voice' = 'chat',
  ): LeadChatPost {
    const lead = this.deps.leadOf(workspaceId);
    const history = this.history(workspaceId);
    const message: StoredMessage = {
      id: this.deps.newId(),
      role: 'person',
      author: { id: author.id, name: author.name },
      text,
      ts: this.now(),
      via,
      state: 'no-lead',
    };
    if (lead) {
      const queueId = this.deps.newId();
      const frame: AgentVoiceFrame & { leadChat: true } = {
        event: 'voice.request',
        workspaceId,
        route: 'agent',
        to: lead.agentId,
        transcript: text,
        ack: sentAck(lead.name),
        queueId,
        conversationId: `lead-chat-${workspaceId}`,
        conversation: history,
        actor: { id: author.id, name: author.name },
        ts: message.ts,
        leadChat: true,
        ...(context ? { context } : {}),
      };
      const sent = this.deps.line.deliver(frame);
      if (sent !== null) {
        message.state = sent > 0 ? 'sent' : 'queued';
        message.queueId = queueId;
        message.sentTo = lead.agentId;
        this.waiting.set(queueId, { workspaceId, messageId: message.id, agentId: lead.agentId });
      }
    }
    if (!this.record(workspaceId, message)) return { ok: false, error: 'write-failed' };
    return { ok: true, message: publicMessage(message) };
  }

  /**
   * The lead's `answer_voice` for `queueId`. True when it answered a chat
   * message on this board, from the agent the message was sent to.
   */
  answer(workspaceId: string, queueId: string, text: string, by: string): boolean {
    this.messages(workspaceId);
    const w = this.waiting.get(queueId);
    if (!w || w.workspaceId !== workspaceId || w.agentId !== by) return false;
    this.waiting.delete(queueId);
    this.reply(w, text);
    return true;
  }

  /** A turn said to `agentId` on a converse socket. Written only when that
   *  agent is the board's lead: a talk with any other agent is not this chat. */
  voiceTurn(
    workspaceId: string,
    agentId: string,
    actor: { id: string; name: string },
    transcript: string,
    queueId: string,
    queued: boolean,
  ): void {
    if (this.deps.leadOf(workspaceId)?.agentId !== agentId) return;
    const message: LeadChatMessage = {
      id: this.deps.newId(),
      role: 'person',
      author: { id: actor.id, name: actor.name },
      text: transcript,
      ts: this.now(),
      via: 'voice',
      state: queued ? 'queued' : 'sent',
    };
    if (this.record(workspaceId, message)) {
      this.spoken.set(queueId, { workspaceId, messageId: message.id, agentId });
    }
  }

  /** The answer to a spoken turn, already said on the socket that asked. */
  voiceReply(workspaceId: string, queueId: string, text: string): void {
    const w = this.spoken.get(queueId);
    if (!w || w.workspaceId !== workspaceId) return;
    this.spoken.delete(queueId);
    this.reply(w, text);
  }

  private reply(w: Waiting, text: string): void {
    const list = this.messages(w.workspaceId);
    const asked = list.find((m) => m.id === w.messageId);
    if (asked) this.record(w.workspaceId, { ...asked, state: 'answered' });
    this.record(w.workspaceId, {
      id: this.deps.newId(),
      role: 'agent',
      author: { id: w.agentId, name: this.deps.leadOf(w.workspaceId)?.name ?? w.agentId },
      text,
      ts: this.now(),
      replyTo: w.messageId,
    });
  }

  /** The turns before the next one, as the lead is handed them. */
  private history(workspaceId: string): ConversationTurn[] {
    return this.messages(workspaceId)
      .slice(-CONVERSATION_KEEP)
      .map((m) => ({
        from: m.role === 'agent' ? 'agent' : 'owner',
        text: m.text.slice(0, HISTORY_TURN_MAX),
      }));
  }

  private messages(workspaceId: string): StoredMessage[] {
    const held = this.boards.get(workspaceId);
    if (held) return held;
    const { messages: list, complete } = this.deps.log.loadBoard(workspaceId);
    this.boards.set(workspaceId, list);
    if (complete) this.complete.add(workspaceId);
    // The questions still open when the server last stopped.
    for (const m of list) {
      if (m.queueId && m.sentTo && m.state !== 'answered') {
        this.waiting.set(m.queueId, { workspaceId, messageId: m.id, agentId: m.sentTo });
      }
    }
    return list;
  }

  private record(workspaceId: string, m: StoredMessage): boolean {
    if (!this.deps.log.append(workspaceId, m)) return false;
    const list = this.messages(workspaceId).filter((x) => x.id !== m.id);
    list.push(m);
    list.sort(compareLeadChatEntries);
    if (list.length > LEAD_CHAT_KEEP) {
      list.splice(0, list.length - LEAD_CHAT_KEEP);
      this.complete.delete(workspaceId);
    }
    this.boards.set(workspaceId, list);
    this.deps.broadcast(workspaceId, {
      event: LEAD_CHAT_EVENT,
      workspaceId,
      message: publicMessage(m),
    });
    return true;
  }
}

type StoredMessage = StoredLeadChatMessage;

/** What a page is handed: never the queue id, which only the lead answers by. */
function publicMessage(m: StoredMessage): LeadChatMessage {
  const { queueId: _queueId, sentTo: _sentTo, ...rest } = m;
  return rest;
}
