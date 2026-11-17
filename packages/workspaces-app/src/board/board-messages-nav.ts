/**
 * The board's Messages item (M10): it opens the lead chat, the same view as
 * the agent button, and the chat's heading picks the channel. It is shown
 * once the reader has a chat to open, and carries a steady dot while any
 * channel holds a message they have not seen.
 */
import type { LeadChatMount } from '../lead-chat/lead-chat-mount.ts';

export function wireMessagesNav(button: HTMLElement | null, chat: LeadChatMount): void {
  if (!button) return;
  const dot = button.querySelector('.board-nav-dot');
  button.addEventListener('click', () => chat.toggle());
  chat.onMessages(({ available, unread }) => {
    button.hidden = !available;
    dot?.classList.toggle('on', unread);
    button.setAttribute('aria-label', unread ? 'Messages, unread' : 'Messages');
    button.setAttribute('aria-expanded', String(!chat.view.pane.hidden));
  });
}
