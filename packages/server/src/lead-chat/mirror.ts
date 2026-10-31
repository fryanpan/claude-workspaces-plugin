/**
 * The lead's session talking, mirrored into the board's lead chat: the text
 * it writes mid-turn and the tool calls it makes, as the plugin's
 * MessageDisplay and PostToolBatch hooks post them
 * (`routes/lead-mirror.ts`). Its prompts and the message each turn ends on
 * come through `LeadChat` itself (`mirrorPrompt`, `mirrorTurnEnd`).
 *
 * A message streams in flush by flush. Each post carries the whole text so
 * far, reduced by the hook, and the flush's index; a post older than the one
 * already shown is dropped, because async hooks can land out of order. The
 * row is shown on every page as it grows and written to the log once, on its
 * final flush — or at the turn's end, if that flush never arrives.
 *
 * Nothing here is sent to the lead or spoken.
 */
import type { LeadChatMessage, LeadChatToolCall } from '@claude-workspaces/core/lead-chat';
import type { LeadChat } from './lead-chat.ts';

/** One flush of a message the lead's session is writing. */
export interface MirroredText {
  /** Claude Code's id for the message, stable across its flushes. */
  messageId: string;
  index: number;
  final: boolean;
  /** The message so far, reduced. */
  text: string;
}

/** The streams remembered, so a late flush of a finished message is dropped. */
const STREAMS_KEPT = 500;
/** The longest one-line summary of a tool call. */
const SUMMARY_MAX = 160;

interface Stream {
  id: string;
  ts: number;
  index: number;
  done: boolean;
}

export class LeadSessionMirror {
  private readonly streams = new Map<string, Stream>();

  constructor(
    private readonly chat: Pick<LeadChat, 'isLead' | 'leadAuthor' | 'showMirrored'>,
    private readonly newId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** A flush of text. False when `agentName` is not the board's lead. */
  text(workspaceId: string, agentName: string, f: MirroredText): boolean {
    if (!this.chat.isLead(workspaceId, agentName)) return false;
    const key = `${workspaceId}\u0000${f.messageId}`;
    const seen = this.streams.get(key);
    if (seen && (seen.done || f.index <= seen.index)) return true;
    const s: Stream = seen ?? { id: this.newId(), ts: this.now(), index: f.index, done: false };
    s.index = f.index;
    s.done = f.final;
    this.remember(key, s);
    const m: LeadChatMessage = {
      id: s.id,
      role: 'agent',
      author: this.chat.leadAuthor(workspaceId, agentName),
      text: f.text,
      ts: s.ts,
      via: 'terminal',
      ...(f.final ? {} : { streaming: true as const }),
    };
    return this.chat.showMirrored(workspaceId, m, f.final);
  }

  /** A batch of tool calls, one row each. False when not the lead's. */
  tools(workspaceId: string, agentName: string, calls: readonly LeadChatToolCall[]): boolean {
    if (!this.chat.isLead(workspaceId, agentName)) return false;
    const author = this.chat.leadAuthor(workspaceId, agentName);
    for (const tool of calls) {
      this.chat.showMirrored(
        workspaceId,
        {
          id: this.newId(),
          role: 'agent',
          author,
          text: toolSummary(tool),
          ts: this.now(),
          via: 'terminal',
          tool,
        },
        true,
      );
    }
    return true;
  }

  private remember(key: string, s: Stream): void {
    this.streams.delete(key);
    this.streams.set(key, s);
    if (this.streams.size > STREAMS_KEPT) {
      const oldest = this.streams.keys().next().value;
      if (oldest !== undefined) this.streams.delete(oldest);
    }
  }
}

/** A tool call in one line, as a terminal shows it: `Bash: git status`. */
export function toolSummary(t: LeadChatToolCall): string {
  const first = t.input.split('\n').find((l) => l.trim() !== '') ?? '';
  const line = first ? `${t.name}: ${first.trim()}` : t.name;
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}
