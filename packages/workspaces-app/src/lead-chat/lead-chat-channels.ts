/**
 * The chat's channel picker (M10): the channel's name is the chat's heading,
 * and a tap on it opens the list of channels — `#general`, the board's chat
 * with its lead, then a one-to-one channel for the reader's own lead agent
 * and for each other person on the board (`dm-client.ts`).
 *
 * Drawing only; which channel is shown and what a send does is
 * `lead-chat-channel-wiring.ts`. A dot on the heading says another channel
 * holds a message the reader has not seen, and a dot on that channel's row
 * says which. Steady, never pulsing (CLAUDE.md, calm by default).
 */

export type ChannelKind = 'general' | 'lead' | 'person';

export interface ChannelEntry {
  id: string;
  kind: ChannelKind;
  name: string;
  /** The line under the heading while this channel is shown. */
  sub: string;
  /** The last line said in it, for its row in the list. */
  last?: string;
  unread: boolean;
}

export interface PickerModel {
  channels: readonly ChannelEntry[];
  current: string;
  menuOpen: boolean;
}

export interface ChannelPicker {
  /** The heading's button: the channel's name and a chevron. */
  button: HTMLButtonElement;
  name: HTMLHeadingElement;
  menu: HTMLElement;
  render(m: PickerModel): void;
}

export const CHANNEL_STYLES = `
.lc-chan-btn { display: inline-flex; align-items: center; gap: 4px; flex: none; min-height: 36px; margin: 0 0 0 -8px; padding: 0 8px; border: 0; border-radius: 8px; background: none; color: inherit; font: inherit; cursor: pointer; position: relative; }
.lc-chan-btn:disabled { cursor: default; }
.lc-chan-btn:hover:not(:disabled) { background: var(--bg-hover, #f6f8fa); }
.lc-chan-btn:focus-visible { outline: 2px solid var(--accent, #2e7dd7); outline-offset: 2px; }
.lc-chev { display: inline-flex; }
.lc-chev[hidden] { display: none; }
.lc-chan-btn svg { width: 16px; height: 16px; color: var(--fg-muted, #57606a); }
.lc-chan-btn .lc-unread { position: absolute; top: 4px; right: 0; }
.lc-unread { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--accent, #2e7dd7); opacity: 0; }
.lc-unread.on { opacity: 1; }
.lc-chan-menu { position: absolute; left: 8px; right: 8px; top: 52px; z-index: 7; max-height: calc(100% - 64px); overflow-y: auto; padding: 6px; border: 1px solid var(--border, #d1d5da); border-radius: 12px; background: var(--bg, #fff); box-shadow: 0 8px 28px rgba(0,0,0,.14); }
.lc-chan-group { margin: 6px 8px 4px; font-size: 12px; font-weight: 600; color: var(--fg-muted, #57606a); }
.lc-chan { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 52px; margin: 0; padding: 6px 8px; border: 0; border-radius: 8px; background: none; color: var(--fg, #1b1f23); font: inherit; text-align: left; cursor: pointer; }
.lc-chan:hover, .lc-chan:focus-visible { background: var(--bg-hover, #f6f8fa); outline: none; }
.lc-chan[aria-selected="true"] { background: #e8f1fc; }
.lc-av { flex: none; width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; color: #fff; background: #2e7dd7; }
.lc-av.lead { border-radius: 9px; background: #1a7f37; }
.lc-av.general { border-radius: 9px; background: #e9ecef; color: var(--fg, #1b1f23); font-size: 16px; }
.lc-chan-text { flex: 1; min-width: 0; }
.lc-chan-name { display: block; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-chan-sub { display: block; font-size: 12.5px; color: var(--fg-muted, #57606a); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-person .lc-msg-text { background: #eef1f4; }
.lc-pane[data-channel="dm"] .lc-chip, .lc-pane[data-channel="dm"] .lc-mic, .lc-pane[data-channel="dm"] .lc-actions > .lc-round:first-child { visibility: hidden; }
`;

const CHEVRON =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M5 8l5 5 5-5"/></svg>';

function make<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

function row(doc: Document, c: ChannelEntry, current: string): HTMLButtonElement {
  const b = make(doc, 'button', 'lc-chan');
  b.type = 'button';
  b.setAttribute('role', 'option');
  b.dataset.chan = c.id;
  b.setAttribute('aria-selected', String(c.id === current));
  const av = make(doc, 'span', `lc-av ${c.kind}`, c.kind === 'general' ? '#' : initials(c.name));
  av.setAttribute('aria-hidden', 'true');
  const text = make(doc, 'span', 'lc-chan-text');
  text.append(
    make(doc, 'span', 'lc-chan-name', c.name),
    make(doc, 'span', 'lc-chan-sub', c.last ?? 'No messages yet'),
  );
  const dot = make(doc, 'span', `lc-unread${c.unread ? ' on' : ''}`);
  if (c.unread) {
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', 'Unread');
  } else dot.setAttribute('aria-hidden', 'true');
  b.append(av, text, dot);
  return b;
}

export function createChannelPicker(doc: Document): ChannelPicker {
  const button = make(doc, 'button', 'lc-chan-btn');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const name = make(doc, 'h2', '', 'Chat with Lead Agent');
  const chevron = make(doc, 'span', 'lc-chev');
  chevron.innerHTML = CHEVRON;
  const dot = make(doc, 'span', 'lc-unread');
  dot.setAttribute('aria-hidden', 'true');
  button.append(name, chevron, dot);
  const menu = make(doc, 'div', 'lc-chan-menu');
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', 'Channels');
  menu.hidden = true;

  return {
    button,
    name,
    menu,
    render(m) {
      const shown = m.channels.find((c) => c.id === m.current) ?? m.channels[0];
      // With one channel there is nothing to pick: the heading is a heading.
      const pickable = m.channels.length > 1;
      button.disabled = !pickable;
      chevron.hidden = !pickable;
      name.textContent = shown?.name ?? 'Chat with Lead Agent';
      const elsewhere = m.channels.some((c) => c.id !== shown?.id && c.unread);
      dot.classList.toggle('on', elsewhere);
      button.setAttribute(
        'aria-label',
        `Channel: ${shown?.name ?? ''}. Change channel${elsewhere ? ', unread messages in another channel' : ''}`,
      );
      button.setAttribute('aria-expanded', String(m.menuOpen && pickable));
      menu.hidden = !(m.menuOpen && pickable);
      if (menu.hidden) return;
      const groups: Array<[string, ChannelEntry[]]> = [
        ['Channels', m.channels.filter((c) => c.kind === 'general')],
        ['Direct messages', m.channels.filter((c) => c.kind !== 'general')],
      ];
      menu.replaceChildren();
      for (const [label, list] of groups) {
        if (list.length === 0) continue;
        menu.append(make(doc, 'div', 'lc-chan-group', label));
        for (const c of list) menu.append(row(doc, c, shown?.id ?? ''));
      }
    },
  };
}
