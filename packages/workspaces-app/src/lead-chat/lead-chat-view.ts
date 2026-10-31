/**
 * The lead chat's DOM: the agent button, the bar that comes out of it, and
 * the panel the bar grows into. Drawing and placing only — what a tap does
 * is `lead-chat-mount.ts`.
 *
 * The bar is attached to the button. Wide (above 1100px) it runs from the
 * button's right edge along the button's own row; narrow it spans the screen
 * with 8px margins, just above the button. Either way it stops short of the
 * page's bottom-right corner, whose buttons belong to the comment widget and
 * the doc's mic and are never covered.
 *
 * The panel sits right of centre on a wide screen and is a sheet on a narrow
 * one, stopping at the board's tab bar so the button stays in reach.
 *
 * The lead's messages are markdown, drawn by the comments' escape-first
 * renderer (`comment-markdown.ts`), so a tag in one is text. A person's own
 * stay plain text. Scrolled to the top, the list asks for the page before
 * (`nearTop`) and keeps the line the reader was on where it was.
 */
import type { LeadChatLead, LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import { renderCommentMarkdown } from '../comment-markdown.ts';
import {
  MEETING_STYLES,
  type MeetingView,
  type MeetingViewModel,
  createMeetingView,
} from './lead-chat-meeting-view.ts';
import { BUTTON_STYLES, LAYER_STYLES } from './lead-chat-styles.ts';

const SPARKLE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>';
const MIC =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>';
const CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/** At or under this width the page is in the mobile tier (design-mobile.md). */
export const NARROW_MAX = 1100;
/** Room kept clear at the bottom-right corner when none of its buttons can
 *  be measured. */
export const CORNER_ROOM = 72;
const BAR_H_NARROW = 50;
const IDLE_RUN = { phase: 'idle', note: '', partial: '' } as const;
const PANEL_W = 440;
/** How close to the top of the list, in pixels, asks for the page before. */
const OLDER_AT = 80;

export interface LeadChatViewModel {
  lead: LeadChatLead | null;
  messages: readonly LeadChatMessage[];
  canTalk: boolean;
  loaded: boolean;
  meId: string;
  open: boolean;
  barOut: boolean;
  /** Voice is on: the mic is listening, or the lead is answering what it
   *  heard. */
  listening: boolean;
  /** Where the spoken question is (`lead-chat-voice.ts`); absent is listening. */
  voice?: 'listening' | 'working' | 'speaking';
  /** What the listener has heard of the question in progress. */
  heard: string;
  /** A one-line notice: a send that failed, a blocked microphone. */
  notice: string;
  /** The board's meeting, when one runs; absent draws no meeting. */
  meeting?: MeetingViewModel;
  /** Older messages than the first shown exist, and whether they are on
   *  their way. */
  more?: boolean;
  loadingOlder?: boolean;
}

export interface LeadChatView {
  button: HTMLButtonElement;
  bar: HTMLButtonElement;
  pane: HTMLElement;
  list: HTMLElement;
  composer: HTMLTextAreaElement;
  mic: HTMLButtonElement;
  send: HTMLButtonElement;
  close: HTMLButtonElement;
  /** "Start a meeting", in the header while no meeting runs. */
  start: HTMLButtonElement;
  meeting: MeetingView;
  /** The layer's shadow root, which the meeting wizard draws into. */
  root: ShadowRoot;
  render(m: LeadChatViewModel): void;
  /** The open list is scrolled to its top, or too short to scroll. */
  nearTop(): boolean;
  /** Re-measure and place the bar and the panel. */
  place(): void;
  destroy(): void;
}

export interface LeadChatViewOpts {
  document: Document;
  /** Holds the button: a slot in the board's dock, or a fresh element
   *  floated at the page's foot. */
  buttonHost: HTMLElement;
  placement: 'dock' | 'float';
}

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
  if (m.listening && (m.voice ?? 'listening') === 'listening') {
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
  if (m.listening) return m.heard ? `Heard: ${m.heard}` : 'Listening…';
  const last = m.messages.at(-1);
  if (last?.role === 'person' && last.state === 'sent') {
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

/** The note under one of the person's messages, when it did not simply go. */
export function deliveryNote(msg: LeadChatMessage, lead: LeadChatLead | null): string {
  if (msg.role !== 'person') return '';
  if (msg.state === 'queued') return `${lead?.name ?? 'Your lead'} reads it when it is back`;
  if (msg.state === 'no-lead') return 'This board has no lead to read it';
  return '';
}

export function createLeadChatView(opts: LeadChatViewOpts): LeadChatView {
  const { document: doc, buttonHost } = opts;
  const win = doc.defaultView ?? window;

  buttonHost.dataset.placement = opts.placement;
  const bRoot = buttonHost.attachShadow({ mode: 'open' });
  const bStyle = make(doc, 'style');
  bStyle.textContent = BUTTON_STYLES;
  const button = make(doc, 'button');
  button.type = 'button';
  button.className = 'lc-agent';
  button.title = 'Ask Workspaces';
  button.setAttribute('aria-label', 'Ask Workspaces');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = SPARKLE;
  bRoot.append(bStyle, button);

  const layer = make(doc, 'div');
  layer.dataset.leadChat = 'layer';
  const root = layer.attachShadow({ mode: 'open' });
  const style = make(doc, 'style');
  style.textContent = LAYER_STYLES + MEETING_STYLES;

  const bar = make(doc, 'button', 'lc-bar');
  bar.type = 'button';
  bar.hidden = true;
  bar.setAttribute('aria-label', 'Open the chat with your agents');
  const barText = make(doc, 'span', 'lc-bar-lines');
  bar.append(barText);

  const pane = make(doc, 'section', 'lc-pane');
  pane.hidden = true;
  pane.setAttribute('role', 'dialog');
  pane.setAttribute('aria-label', 'Your agents');
  const head = make(doc, 'header', 'lc-head');
  const title = make(doc, 'div', 'lc-title');
  const h2 = make(doc, 'h2', '', 'Your agents');
  const who = make(doc, 'p');
  title.append(h2, who);
  const close = make(doc, 'button', 'lc-icon lc-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.title = 'Close';
  close.innerHTML = CLOSE;
  const start = make(doc, 'button', 'lc-start', 'Start a meeting');
  start.type = 'button';
  const meeting = createMeetingView(doc);
  head.append(title, meeting.head, start, close);
  const list = make(doc, 'div', 'lc-list');
  list.setAttribute('role', 'log');
  list.setAttribute('aria-live', 'polite');
  const status = make(doc, 'div', 'lc-status');
  const compose = make(doc, 'div', 'lc-compose');
  const composer = make(doc, 'textarea');
  composer.rows = 1;
  composer.placeholder = 'Message your lead';
  composer.setAttribute('aria-label', 'Message your lead');
  composer.maxLength = 4000;
  const mic = make(doc, 'button', 'lc-icon lc-mic');
  mic.type = 'button';
  mic.setAttribute('aria-pressed', 'false');
  mic.innerHTML = MIC;
  const send = make(doc, 'button', 'lc-send', 'Send');
  send.type = 'button';
  compose.append(composer, mic, send);
  const readonly = make(doc, 'p', 'lc-readonly', 'Only the board’s owner talks to its lead.');
  readonly.hidden = true;
  pane.append(head, meeting.notes, list, status, compose, readonly);
  root.append(style, bar, pane);
  doc.body.append(layer);

  const narrow = (): boolean => win.innerWidth <= NARROW_MAX;
  /** Where the page's foot begins: the top of the board's tab bar when it
   *  runs along the bottom, or of a floated agent button, so a sheet stops
   *  above both and the button stays in reach. */
  const footTop = (): number => {
    const vh = win.innerHeight;
    const r = doc.querySelector('.board-nav')?.getBoundingClientRect();
    const nav = r && r.height > 0 && r.top > vh / 2 ? r.top : vh;
    if (opts.placement !== 'float') return nav;
    return Math.min(nav, button.getBoundingClientRect().top - 8);
  };
  /** The left edge of the buttons already in the bottom-right corner — the
   *  comment widget's — which nothing here may cover; on one row only, when
   *  given. */
  const cornerLeft = (vw: number, vh: number, row?: { top: number; bottom: number }): number => {
    const els: Element[] = [];
    const widget = doc.querySelector('claude-feedback-widget');
    if (widget?.shadowRoot) els.push(...widget.shadowRoot.querySelectorAll('button'));
    // Unmeasured, the default room — except on a row the caller names, where
    // only a button actually on that row takes any.
    let left = row ? vw : vw - CORNER_ROOM + 12;
    const { top, bottom } = row ?? { top: vh / 2, bottom: vh };
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const onRow = r.bottom > top && r.top < bottom;
      if (r.width > 0 && r.width <= 200 && onRow && r.left > vw / 2) {
        left = Math.min(left, r.left);
      }
    }
    return left;
  };
  /** A sheet covers the screen, so the widget's corner buttons step aside
   *  while it is up rather than sit over its composer. */
  const hideWidget = (hide: boolean): void => {
    const widget = doc.querySelector<HTMLElement>('claude-feedback-widget');
    if (widget) widget.style.visibility = hide ? 'hidden' : '';
  };

  let lastNewest: string | undefined;
  let lastOldest: string | undefined;
  let wasOpen = false;
  /** The lead's messages as drawn, by id and text: a re-render while the
   *  mic hears a line redraws the list but parses nothing again. */
  const drawn = new Map<string, { text: string; html: string }>();
  const markdown = (msg: LeadChatMessage): string => {
    const hit = drawn.get(msg.id);
    if (hit?.text === msg.text) return hit.html;
    const html = renderCommentMarkdown(msg.text, { bareLinks: true });
    drawn.set(msg.id, { text: msg.text, html });
    return html;
  };

  const place = (): void => {
    const vw = doc.documentElement.clientWidth || win.innerWidth;
    const vh = win.innerHeight;
    const a = button.getBoundingClientRect();
    const corner = cornerLeft(vw, vh);
    if (!bar.hidden) {
      if (narrow()) {
        const foot = Math.min(a.top, footTop());
        // Across the screen, short of a corner button that rides the same row.
        const top = Math.round(foot - BAR_H_NARROW - 8);
        const right = cornerLeft(vw, vh, { top, bottom: top + BAR_H_NARROW }) - 8;
        bar.style.cssText = `left:8px;width:${Math.round(right - 8)}px;top:${top}px;height:${BAR_H_NARROW}px`;
      } else {
        const left = Math.round(a.right + 8);
        bar.style.cssText = `left:${left}px;width:${Math.max(120, Math.round(corner - 8 - left))}px;top:${Math.round(a.top)}px;height:${Math.round(a.height)}px`;
      }
    }
    const sheet = !pane.hidden && narrow();
    hideWidget(sheet);
    if (!pane.hidden) {
      pane.classList.toggle('lc-sheet', sheet);
      if (sheet) {
        pane.style.cssText = `left:0;right:0;top:40px;bottom:${Math.round(vh - footTop())}px`;
      } else {
        const right = Math.round(vw - corner + 12);
        const width = Math.min(PANEL_W, vw - right - 16);
        pane.style.cssText = `right:${right}px;width:${width}px;top:64px;bottom:16px`;
      }
    }
  };

  const renderList = (m: LeadChatViewModel): void => {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const prevHeight = list.scrollHeight;
    const prevTop = list.scrollTop;
    list.replaceChildren();
    // Always drawn above a non-empty list, one line high, so its words can
    // change without moving the messages under it.
    if (m.messages.length > 0) list.append(make(doc, 'p', 'lc-history', historyLine(m)));
    if (m.messages.length === 0) {
      const empty = make(
        doc,
        'p',
        'lc-empty',
        m.lead
          ? `Ask ${m.lead.name} anything about this board. It sees the page you are on.`
          : 'This board has no lead yet. Set one in Settings, and it reads what you write here.',
      );
      list.append(empty);
    }
    for (const msg of m.messages) {
      const mine = msg.role === 'person';
      const item = make(doc, 'div', `lc-msg ${mine ? 'lc-you' : 'lc-agent'}`);
      item.dataset.messageId = msg.id;
      const name = mine ? (msg.author.id === m.meId ? 'You' : msg.author.name) : msg.author.name;
      let body: HTMLElement;
      if (mine) {
        body = make(doc, 'span', 'lc-msg-text', msg.text);
      } else {
        body = make(doc, 'div', 'lc-msg-text lc-md');
        body.innerHTML = markdown(msg);
      }
      item.append(
        make(doc, 'span', 'lc-msg-who', msg.via === 'voice' ? `${name}, by voice` : name),
        body,
      );
      const note = deliveryNote(msg, m.lead);
      if (note) item.append(make(doc, 'span', 'lc-note', note));
      list.append(item);
    }
    // Follow the conversation when the reader is at its foot, or it grew
    // while they were not looking; never pull them off a line they scrolled
    // to. A page read back above them grows the list upward, so the line
    // they were reading stays where it was.
    const newest = m.messages.at(-1)?.id;
    const oldest = m.messages[0]?.id;
    if (nearBottom || newest !== lastNewest || !wasOpen) {
      list.scrollTop = list.scrollHeight;
    } else if (oldest !== lastOldest) {
      list.scrollTop = prevTop + (list.scrollHeight - prevHeight);
    }
    lastNewest = newest;
    lastOldest = oldest;
  };

  return {
    button,
    bar,
    pane,
    list,
    composer,
    mic,
    send,
    close,
    start,
    meeting,
    root,
    render(m) {
      const out = m.open || m.barOut;
      button.setAttribute('aria-expanded', String(out));
      button.dataset.listening = String(m.listening);
      button.title = out ? (m.listening ? 'Close and stop listening' : 'Close') : 'Ask Workspaces';
      bar.hidden = !m.barOut || m.open;
      pane.hidden = !m.open;
      barText.replaceChildren();
      for (const line of barLines(m)) {
        const row = make(doc, 'span', `lc-bar-line${line.dim ? ' lc-dim' : ''}`);
        row.append(make(doc, 'b', '', `${line.who}: `), line.text);
        barText.append(row);
      }
      who.textContent = m.lead ? `with ${m.lead.name}` : m.loaded ? 'No lead on this board' : '';
      status.textContent = statusLine(m);
      const meetingOn = !!m.meeting?.meeting;
      title.hidden = meetingOn;
      start.hidden = meetingOn || !m.canTalk || !m.loaded;
      meeting.render(
        m.meeting ?? { meeting: null, run: IDLE_RUN, recording: false, ending: false },
      );
      // In a meeting the room's voice is the meeting's; the lead hears a
      // line that opens with "Lead,", so the chat's own mic steps aside.
      mic.hidden = meetingOn;
      compose.hidden = !m.canTalk;
      readonly.hidden = m.canTalk || !m.loaded;
      mic.setAttribute('aria-pressed', String(m.listening));
      const micLabel = m.listening ? 'Stop listening' : 'Talk to your lead';
      mic.setAttribute('aria-label', micLabel);
      mic.title = micLabel;
      send.disabled = composer.value.trim() === '';
      // Placed first, so the list has its height when it scrolls to its foot.
      place();
      if (m.open) renderList(m);
      wasOpen = m.open;
    },
    nearTop: () => !pane.hidden && list.scrollTop < OLDER_AT,
    place,
    destroy() {
      hideWidget(false);
      layer.remove();
      bRoot.replaceChildren();
    },
  };
}
