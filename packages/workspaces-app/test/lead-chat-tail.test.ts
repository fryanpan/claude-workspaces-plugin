/**
 * Which lines keep their end in view. Only words still being heard do: a
 * notice, a working line or a finished message keeps its start. The layout
 * itself is `lead-chat-heard-browser.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { drawBarLines, drawStatus } from '../src/lead-chat/lead-chat-tail.ts';
import type { LeadChatViewModel } from '../src/lead-chat/lead-chat-view.ts';

const model = (over: Partial<LeadChatViewModel>): LeadChatViewModel =>
  ({ messages: [], notice: '', heard: '', listening: false, ...over }) as LeadChatViewModel;

const row = (): HTMLElement => {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
};

describe('the status', () => {
  it('holds the heard words as a label beside a clip, reading as one sentence', () => {
    const status = row();
    drawStatus(status, model({ listening: true, heard: 'the ferry task' }));
    expect(status.classList.contains('lc-tail')).toBe(true);
    expect(status.textContent).toBe('Heard: the ferry task');
    expect(status.querySelector('.lc-tail-text')?.textContent).toBe('the ferry task');
  });

  it('goes back to a plain line when something else takes the status', () => {
    const status = row();
    drawStatus(status, model({ listening: true, heard: 'the ferry task' }));
    drawStatus(status, model({ listening: true, heard: 'the ferry task', notice: 'No sound' }));
    expect(status.classList.contains('lc-tail')).toBe(false);
    expect(status.textContent).toBe('No sound');

    drawStatus(status, model({ listening: true, heard: 'the ferry task' }));
    drawStatus(status, model({ listening: true, heard: 'the ferry task', voice: 'working' }));
    expect(status.classList.contains('lc-tail')).toBe(false);
    expect(status.textContent).toBe('Your lead is working on it');
  });
});

describe('the bar', () => {
  it('keeps the end of the heard line and the start of a message', () => {
    const box = row();
    const said = {
      role: 'person',
      text: 'an earlier message',
    } as LeadChatViewModel['messages'][number];
    drawBarLines(box, model({ messages: [said], listening: true, heard: 'the ferry task' }));
    const [message, heard] = [...box.children];
    expect(message?.classList.contains('lc-tail')).toBe(false);
    expect(message?.textContent).toBe('You: an earlier message');
    expect(heard?.classList.contains('lc-tail')).toBe(true);
    expect(heard?.textContent).toBe('You: the ferry task');
  });

  it('shows Listening… as a plain dim line until a word is heard', () => {
    const box = row();
    drawBarLines(box, model({ listening: true }));
    const line = box.firstElementChild;
    expect(line?.classList.contains('lc-tail')).toBe(false);
    expect(line?.classList.contains('lc-dim')).toBe(true);
    expect(line?.textContent).toBe('You: Listening…');
  });
});
