/**
 * The shapes of a lead chat row: who a mirrored row is by, what a page is
 * handed of one, and how a message's files read to the lead.
 */
import type { LeadChatAttachment, LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import type { StoredLeadChatMessage } from './log.ts';

export type StoredMessage = StoredLeadChatMessage;

/** Who a mirrored terminal prompt and a mirrored board event are by. */
export const TERMINAL_AUTHOR_ID = 'lead-terminal';
export const CHANNEL_AUTHOR_ID = 'lead-channel';

/** What the lead reads about a message's files: one line each, with the id
 *  `read_chat_attachment` takes. */
export function attachmentLines(
  workspaceId: string,
  files: readonly LeadChatAttachment[],
): string {
  if (files.length === 0) return '';
  const lines = files.map(
    (f) =>
      `[Attached: ${JSON.stringify(f.name)} (${f.image ? f.type : 'file'}, ${f.size} bytes). ` +
      `Read it with read_chat_attachment(workspaceId="${workspaceId}", fileId="${f.id}").]`,
  );
  return `\n${lines.join('\n')}`;
}

/** The Stop note's closing row for these words (one may be cut shorter). */
export function closingRowOf(
  list: readonly StoredMessage[],
  text: string,
): StoredMessage | undefined {
  const words = text.trim();
  if (!words) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m) continue;
    if (m.role === 'person' && m.via !== 'channel') return undefined;
    if (m.role !== 'agent' || !m.turnEnd || m.via === 'terminal') continue;
    const said = m.text.trim();
    if (said === words || said.startsWith(words) || words.startsWith(said)) return m;
    return undefined;
  }
  return undefined;
}

export function withoutStreaming(m: StoredMessage): StoredMessage {
  const { streaming: _streaming, ...rest } = m;
  return rest;
}

/** A row the lead's own session put here, which the lead is never handed
 *  back as conversation. */
export function isMirrored(m: LeadChatMessage): boolean {
  return m.via === 'terminal' || m.via === 'channel' || m.turnEnd === true;
}

/** What a page is handed: never the queue id, which only the lead answers by. */
export function publicMessage(m: StoredMessage): LeadChatMessage {
  const { queueId: _queueId, sentTo: _sentTo, ...rest } = m;
  return rest;
}
