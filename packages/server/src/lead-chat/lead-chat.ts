import { agentIdForName } from '@claude-workspaces/core/identity';
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
 * The lead's own Claude Code session is mirrored in too, so the chat shows
 * what its terminal shows (`mirror*` below): a prompt typed there, a board
 * event its session took as a prompt, and the message each turn ended on,
 * posted by the plugin's UserPromptSubmit and Stop hooks to the routes they
 * already post to. A message to the lead goes `sent` → `received` when the
 * lead's MCP child acks its queue row (the session has it) → `done` when
 * that session's turn ends, or `answered` when the lead answers it. Nothing
 * mirrored is sent to the lead again or spoken: speech is `answer_voice`'s
 * alone.
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

/** A prompt the lead's session took, as its UserPromptSubmit hook posts it
 *  (`routes/prompt-marks.ts`). */
export interface MirroredPrompt {
  typed: boolean;
  /** A typed prompt's text, reduced by the hook. */
  text?: string;
  /** A board event the session took as a prompt: who caused it, one reduced
   *  line of it, and the queue row it delivered, when it was one. */
  channel?: { author?: string; text: string; queueId?: string };
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

  /** The board's lead is the session `agentName` names: by the id an agent
   *  of that name attaches under, or by the name it attached with. */
  isLead(workspaceId: string, agentName: string): boolean {
    const lead = this.deps.leadOf(workspaceId);
    if (!lead) return false;
    return agentIdForName(agentName) === lead.agentId || agentName === lead.name;
  }

  /**
   * The lead's MCP child acked queue row `queueId`: the lead's session has
   * the message it carried. A typed or spoken message on this board moves to
   * `received`; anything else is not this chat's.
   */
  received(workspaceId: string, queueId: string): boolean {
    this.messages(workspaceId);
    const w = this.waiting.get(queueId) ?? this.spoken.get(queueId);
    if (!w || w.workspaceId !== workspaceId) return false;
    const m = this.messages(workspaceId).find((x) => x.id === w.messageId);
    if (!m || (m.state !== 'sent' && m.state !== 'queued')) return false;
    return this.record(workspaceId, { ...m, state: 'received', receivedAt: this.now() });
  }

  /**
   * A prompt the lead's session took, mirrored into the chat. A prompt
   * typed in its terminal shows as a person's message; a board event shows
   * as a channel row — unless it is the delivery of a message already in the
   * chat, which only moves that message to `received`. False when `agentName`
   * is not the lead or there is nothing to show.
   */
  mirrorPrompt(workspaceId: string, agentName: string, p: MirroredPrompt): boolean {
    if (!this.isLead(workspaceId, agentName)) return false;
    if (p.typed) {
      if (!p.text) return false;
      return this.record(workspaceId, {
        id: this.deps.newId(),
        role: 'person',
        author: { id: TERMINAL_AUTHOR_ID, name: 'Terminal' },
        text: p.text,
        ts: this.now(),
        via: 'terminal',
      });
    }
    const c = p.channel;
    if (!c?.text) return false;
    if (c.queueId) {
      this.messages(workspaceId);
      if (this.waiting.has(c.queueId) || this.spoken.has(c.queueId)) {
        this.received(workspaceId, c.queueId);
        return true;
      }
    }
    return this.record(workspaceId, {
      id: this.deps.newId(),
      role: 'person',
      author: { id: CHANNEL_AUTHOR_ID, name: c.author ?? 'Board' },
      text: c.text,
      ts: this.now(),
      via: 'channel',
    });
  }

  /**
   * The message the lead's turn ended on, as its Stop hook posts it. Shown as
   * the lead's message and never spoken. Every message the turn had taken
   * and not answered moves to `done`. A closing message the chat already
   * shows as this turn's answer is not shown twice.
   *
   * Mirrored rows are stamped with the server's clock when they arrive, not
   * the hook's: the chat's order is the order its pages saw, and a lead on
   * another machine has a clock of its own.
   */
  mirrorTurnEnd(workspaceId: string, agentName: string, text: string): boolean {
    if (!this.isLead(workspaceId, agentName)) return false;
    const list = this.messages(workspaceId);
    for (const m of list) {
      if (m.role === 'person' && m.state === 'received') {
        this.record(workspaceId, { ...m, state: 'done' });
      }
    }
    const words = text.trim();
    if (!words) return false;
    let lastPerson = list.length - 1;
    while (lastPerson >= 0) {
      const m = list[lastPerson];
      if (m && m.role === 'person' && m.via !== 'channel') break;
      lastPerson--;
    }
    const repeat = list
      .slice(lastPerson + 1)
      .some((m) => m.role === 'agent' && m.text.trim() === words);
    if (repeat) return false;
    const lead = this.deps.leadOf(workspaceId);
    return this.record(workspaceId, {
      id: this.deps.newId(),
      role: 'agent',
      author: { id: lead?.agentId ?? agentName, name: lead?.name ?? agentName },
      text: words,
      ts: this.now(),
      turnEnd: true,
    });
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
      .filter((m) => !isMirrored(m))
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

/** Who a mirrored terminal prompt and a mirrored board event are by. */
export const TERMINAL_AUTHOR_ID = 'lead-terminal';
export const CHANNEL_AUTHOR_ID = 'lead-channel';

/** A row the lead's own session put here, which the lead is never handed
 *  back as conversation. */
function isMirrored(m: LeadChatMessage): boolean {
  return m.via === 'terminal' || m.via === 'channel' || m.turnEnd === true;
}

/** What a page is handed: never the queue id, which only the lead answers by. */
function publicMessage(m: StoredMessage): LeadChatMessage {
  const { queueId: _queueId, sentTo: _sentTo, ...rest } = m;
  return rest;
}
