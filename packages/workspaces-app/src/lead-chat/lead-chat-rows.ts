/**
 * One message of the lead chat as the list draws it. `lead-chat-view.ts`
 * places the list; this decides what each entry looks like.
 *
 * Most entries are bubbles: a person's message on the right, the lead's on
 * the left as markdown. The lead's own session adds three kinds
 * (`server/src/lead-chat/mirror.ts`), drawn compact so the conversation
 * stays readable:
 *
 * - a tool call: one line naming the tool and its input, which opens to the
 *   input and output the hook sent, already scrubbed;
 * - a board event the session took as a prompt: one dashed line naming who
 *   caused it, which opens to the whole line, and which the header's toggle
 *   hides;
 * - a spoken reply: a short bubble that says it was spoken, whose words
 *   open on a tap.
 *
 * A person's message carries where it got to, one steady line under it:
 * Sent, Received, Working, Done or Answered. Nothing blinks (CLAUDE.md, calm
 * by default).
 */
import type { LeadChatLead, LeadChatMessage } from '@claude-workspaces/core/lead-chat';

export interface RowContext {
  doc: Document;
  meId: string;
  lead: LeadChatLead | null;
  /** Ids of the compact rows and voice bubbles the reader opened. */
  open: ReadonlySet<string>;
  showChannel: boolean;
  /** The lead's markdown, rendered safely (`comment-markdown.ts`). */
  markdown(msg: LeadChatMessage): string;
  /** The whole list, for the line under a person's message. */
  messages: readonly LeadChatMessage[];
}

const CHEVRON = '›';

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A row from the lead's session. */
export const isSessionRow = (m: LeadChatMessage): boolean =>
  m.via === 'terminal' && m.role === 'agent';

/**
 * Where a person's message got to, or null for one that is not a message to
 * the lead. Received turns to Working once the lead's session has shown
 * anything after it.
 */
export function messageState(
  msg: LeadChatMessage,
  list: readonly LeadChatMessage[],
): { s: 'sent' | 'received' | 'working' | 'done' | 'answered'; text: string } | null {
  if (msg.role !== 'person' || (msg.via !== undefined && msg.via !== 'chat' && msg.via !== 'voice'))
    return null;
  switch (msg.state) {
    case 'sent':
      return { s: 'sent', text: 'Sent' };
    case 'received': {
      const since = msg.receivedAt ?? msg.ts;
      const busy = list.some((m) => isSessionRow(m) && m.ts >= since);
      return busy ? { s: 'working', text: 'Working' } : { s: 'received', text: 'Received' };
    }
    case 'done':
      return { s: 'done', text: 'Done' };
    case 'answered':
      return { s: 'answered', text: 'Answered' };
    default:
      return null;
  }
}

/** The note under a person's message that did not simply go. */
export function deliveryNote(msg: LeadChatMessage, lead: LeadChatLead | null): string {
  if (msg.role !== 'person') return '';
  if (msg.state === 'queued') return `${lead?.name ?? 'Your lead'} reads it when it is back`;
  if (msg.state === 'no-lead') return 'This board has no lead to read it';
  return '';
}

/** A one-line row that opens to a body: a tool call or a board event. */
function compactRow(
  ctx: RowContext,
  msg: LeadChatMessage,
  kind: 'tool' | 'chan',
  parts: { icon: string; label: string; summary: string },
  body: (into: HTMLElement) => void,
): HTMLElement {
  const { doc } = ctx;
  const open = ctx.open.has(msg.id);
  const row = el(doc, 'div', `lc-row lc-${kind}`);
  row.dataset.messageId = msg.id;
  row.dataset.open = String(open);
  const head = el(doc, 'button', 'lc-row-head');
  head.type = 'button';
  head.dataset.toggle = msg.id;
  head.setAttribute('aria-expanded', String(open));
  const icon = el(doc, 'span', 'lc-row-icon', parts.icon);
  icon.setAttribute('aria-hidden', 'true');
  const chev = el(doc, 'span', 'lc-row-chev', CHEVRON);
  chev.setAttribute('aria-hidden', 'true');
  head.append(
    chev,
    icon,
    el(doc, 'span', 'lc-row-kind', parts.label),
    el(doc, 'span', 'lc-row-sum', parts.summary),
  );
  row.append(head);
  if (open) {
    const b = el(doc, 'div', 'lc-row-body');
    body(b);
    row.append(b);
  }
  return row;
}

function toolRow(ctx: RowContext, msg: LeadChatMessage): HTMLElement {
  const t = msg.tool;
  if (!t) throw new Error('not a tool row');
  const first =
    t.input
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? '';
  const row = compactRow(
    ctx,
    msg,
    'tool',
    { icon: t.failed ? '✕' : '●', label: t.name, summary: first },
    (b) => {
      b.append(el(ctx.doc, 'h4', '', 'Input'), el(ctx.doc, 'pre', '', t.input || '(none)'));
      b.append(el(ctx.doc, 'h4', '', 'Output'), el(ctx.doc, 'pre', '', t.output ?? '(no output)'));
    },
  );
  if (t.failed) row.dataset.failed = 'true';
  return row;
}

function channelRow(ctx: RowContext, msg: LeadChatMessage): HTMLElement {
  return compactRow(
    ctx,
    msg,
    'chan',
    { icon: '↳', label: msg.author.name, summary: msg.text.replace(/\s+/g, ' ') },
    (b) => {
      b.append(el(ctx.doc, 'pre', '', msg.text));
    },
  );
}

/** The lead's answer to something said aloud: it was already heard, so it
 *  shows as a bubble whose words open on a tap. */
function voiceReply(ctx: RowContext, msg: LeadChatMessage): HTMLElement {
  const { doc } = ctx;
  const open = ctx.open.has(msg.id);
  const item = el(doc, 'div', 'lc-voice');
  item.dataset.messageId = msg.id;
  item.append(el(doc, 'span', 'lc-msg-who', `${msg.author.name}, spoken`));
  const btn = el(doc, 'button', 'lc-voice-btn');
  btn.type = 'button';
  btn.dataset.toggle = msg.id;
  btn.setAttribute('aria-expanded', String(open));
  const wave = el(doc, 'span', 'lc-wave');
  wave.setAttribute('aria-hidden', 'true');
  for (const h of [6, 12, 9, 14, 7, 11, 5]) {
    const bar = el(doc, 'i');
    bar.style.height = `${h}px`;
    wave.append(bar);
  }
  btn.append(wave, el(doc, 'span', 'lc-voice-words', open ? 'Hide words' : 'Show words'));
  item.append(btn);
  if (open) {
    const text = el(doc, 'div', 'lc-msg-text lc-md lc-voice-text');
    text.innerHTML = ctx.markdown(msg);
    item.append(text);
  }
  return item;
}

function whoFor(ctx: RowContext, msg: LeadChatMessage): string {
  if (msg.role === 'agent') return msg.author.name;
  if (msg.via === 'terminal') return 'In the terminal';
  const name = msg.author.id === ctx.meId ? 'You' : msg.author.name;
  return msg.via === 'voice' ? `${name}, by voice` : name;
}

/** One entry, or null for a board event the reader has hidden. */
export function drawMessage(ctx: RowContext, msg: LeadChatMessage): HTMLElement | null {
  if (msg.tool) return toolRow(ctx, msg);
  if (msg.role === 'person' && msg.via === 'channel') {
    return ctx.showChannel ? channelRow(ctx, msg) : null;
  }
  if (msg.role === 'agent' && msg.replyTo) {
    const asked = ctx.messages.find((m) => m.id === msg.replyTo);
    if (asked?.via === 'voice') return voiceReply(ctx, msg);
  }
  const { doc } = ctx;
  const mine = msg.role === 'person';
  const item = el(doc, 'div', `lc-msg ${mine ? 'lc-you' : 'lc-agent'}`);
  item.dataset.messageId = msg.id;
  let body: HTMLElement;
  if (mine) {
    body = el(doc, 'span', 'lc-msg-text', msg.text);
  } else {
    body = el(doc, 'div', 'lc-msg-text lc-md');
    body.innerHTML = ctx.markdown(msg);
  }
  item.append(el(doc, 'span', 'lc-msg-who', whoFor(ctx, msg)), body);
  const state = messageState(msg, ctx.messages);
  if (state) {
    const line = el(doc, 'span', 'lc-state');
    line.dataset.s = state.s;
    const dot = el(doc, 'span', 'lc-dot');
    dot.setAttribute('aria-hidden', 'true');
    line.append(dot, state.text);
    item.append(line);
  }
  const note = deliveryNote(msg, ctx.lead);
  if (note) item.append(el(doc, 'span', 'lc-note', note));
  return item;
}

/** How many board events the toggle is hiding. */
export const channelCount = (list: readonly LeadChatMessage[]): number =>
  list.filter((m) => m.role === 'person' && m.via === 'channel').length;
