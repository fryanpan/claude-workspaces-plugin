/**
 * The short lines the lead chat writes around its messages: the bar's two
 * lines, the status under the list, and the line above the first message.
 * `lead-chat-view.ts` puts them on the page.
 */
import type { LeadChatViewModel } from './lead-chat-view.ts';

/** Said while listening is on here and another tab hears the reader. */
export const PAUSED = 'Paused. Listening in your other tab.';

/** The person's lines and the lead's, newest last, as the bar shows them. */
export function barLines(
  m: LeadChatViewModel,
): Array<{ who: string; text: string; dim?: boolean }> {
  const lines: Array<{ who: string; text: string; dim?: boolean }> = m.messages
    .slice(-2)
    .map((x) => ({
      who: x.role === 'agent' ? x.author.name : 'You',
      text: x.text.replace(/\s+/g, ' '),
    }));
  if (m.listening && m.paused && (m.voice ?? 'listening') === 'listening') {
    lines.push({ who: 'You', text: PAUSED, dim: true });
  } else if (m.listening && (m.voice ?? 'listening') === 'listening') {
    lines.push({ who: 'You', text: m.heard || 'Listening…', dim: !m.heard });
  } else if (lines.length === 0) {
    lines.push({ who: m.lead?.name ?? 'Your agents', text: 'Tap to open the chat', dim: true });
  }
  return lines.slice(-2);
}

/** The line under the list: who is working on what, or what went wrong. */
export function statusLine(m: LeadChatViewModel): string {
  if (m.notice) return m.notice;
  const lead = m.lead?.name ?? 'Your lead';
  if (m.listening && m.voice === 'working') return `${lead} is working on it`;
  if (m.listening && m.voice === 'speaking') return `${lead} is answering`;
  if (m.listening && m.paused) return PAUSED;
  if (m.listening) return m.heard ? `Heard: ${m.heard}` : 'Listening…';
  const last = m.messages.at(-1);
  if (last?.role === 'person' && last.state === 'sent') {
    return `${lead} is working on it`;
  }
  if (m.messages.some((x) => x.role === 'person' && x.state === 'received')) {
    return `${lead} is working on it`;
  }
  return '';
}

/** The quiet line above the first message shown: older ones on their way,
 *  or the conversation's start. Empty while more wait to be scrolled to. */
export function historyLine(m: LeadChatViewModel): string {
  if (m.messages.length === 0) return '';
  if (m.loadingOlder) return 'Loading earlier messages…';
  if (m.more) return '';
  return `Start of your conversation${m.lead ? ` with ${m.lead.name}` : ''}`;
}
