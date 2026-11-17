/**
 * The lead chat's bar, built for a real browser: a button holding the rows
 * `drawBarLines` draws, in the shipped bar styles, with a count of the clicks it took.
 *
 * `lead-chat-bar-tap-browser-driver.ts` bundles this and redraws the rows
 * between a press and its release, as a transcript update does on the page.
 */
import { LAYER_STYLES } from '../src/lead-chat/lead-chat-styles.ts';
import { drawBarLines } from '../src/lead-chat/lead-chat-tail.ts';
import type { LeadChatViewModel } from '../src/lead-chat/lead-chat-view.ts';

declare global {
  interface Window {
    cwBar: { draw: (over: Partial<LeadChatViewModel>) => void; clicks: () => number };
  }
}

// The shipped styles, so heard words longer than the bar are cut as they are
// on the page.
const style = document.createElement('style');
style.textContent = LAYER_STYLES;
document.head.append(style);
const bar = document.createElement('button');
bar.className = 'lc-bar';
bar.style.cssText = 'top:20px;left:20px;width:300px;height:48px';
const lines = document.createElement('span');
lines.className = 'lc-bar-lines';
bar.append(lines);
document.body.append(bar);
let clicks = 0;
bar.addEventListener('click', () => {
  clicks++;
});

window.cwBar = {
  draw: (over) =>
    drawBarLines(lines, {
      messages: [],
      notice: '',
      heard: '',
      listening: true,
      ...over,
    } as LeadChatViewModel),
  clicks: () => clicks,
};
