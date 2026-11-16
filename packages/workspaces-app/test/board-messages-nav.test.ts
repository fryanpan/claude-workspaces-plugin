/**
 * The board's Messages item opens and closes the lead chat, shows only once
 * there is a chat to open, and wears a dot while a channel holds a message
 * the reader has not seen.
 */
import { describe, expect, it } from 'vitest';
import { wireMessagesNav } from '../src/board/board-messages-nav.ts';
import type { LeadChatMount } from '../src/lead-chat/lead-chat-mount.ts';

function fakeChat() {
  const pane = document.createElement('section');
  pane.hidden = true;
  let tell: (m: { available: boolean; unread: boolean }) => void = () => {};
  const chat = {
    view: { pane },
    toggle() {
      pane.hidden = !pane.hidden;
    },
    onMessages(fn: typeof tell) {
      tell = fn;
    },
  } as unknown as LeadChatMount;
  return { chat, pane, tell: (m: { available: boolean; unread: boolean }) => tell(m) };
}

describe('the Messages item', () => {
  it('shows once there is a chat, toggles it, and carries the unread dot', () => {
    const button = document.createElement('button');
    button.hidden = true;
    button.innerHTML = '<span class="board-nav-dot"></span>';
    const { chat, pane, tell } = fakeChat();
    wireMessagesNav(button, chat);

    tell({ available: false, unread: false });
    expect(button.hidden).toBe(true);
    tell({ available: true, unread: true });
    expect(button.hidden).toBe(false);
    expect(button.querySelector('.board-nav-dot')?.classList.contains('on')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Messages, unread');

    button.click();
    expect(pane.hidden).toBe(false);
    tell({ available: true, unread: false });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.querySelector('.board-nav-dot')?.classList.contains('on')).toBe(false);
    button.click();
    expect(pane.hidden).toBe(true);
  });
});
