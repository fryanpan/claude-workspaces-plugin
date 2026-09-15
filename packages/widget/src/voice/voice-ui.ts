import { escapeHtml as escape } from '@claude-workspaces/core';
import { isPhoneFace } from '../widget-card.ts';
import { stackColumn } from './voice-column.ts';
import { VOICE_CSS } from './voice-css.ts';
import type { VoiceComment, VoiceSession } from './voice-session.ts';

/**
 * What a recording looks like on the page — the round-4 design the owner
 * approved ("Build it"), with the finished-notes flow of the round after.
 *
 * - Nothing pulses or blinks (calm by default, owner 2026-09-13): the live
 *   comment carries a steady red recording dot, and the mic is a still red
 *   Stop button with no timer.
 * - The live comment shows the finished note, and under it, grey, the words
 *   said since the last pause. At the pause they are folded into the note.
 *   One faded line keeps the note's raw words; a tap shows all of them.
 * - It floats above the buttons until the transcriber picks an element, then
 *   stands beside it. Move, then a tap on the element, fixes a wrong pick.
 * - Every other note stands beside the page as a card (a dot on its element,
 *   on a phone); a tap on either adds to that note again.
 * - No byline, no counts, no "Posted" label.
 * - Every voice comment keeps its clip (▶) and its raw words at its foot.
 *
 * Drawn from the session's state every time it changes; placed every frame
 * while there is anything on screen, since the element it stands beside can
 * scroll or move.
 */

/** Must match `.vlive` / `.vcard` width below. */
const CARD_W = 280;
/** How far up from the bottom a card must stay when the mic is not on screen to measure. */
const BUTTONS_H = 190;
/** On a phone, how long the newest settled card stays up once recording stops. */
export const SETTLED_MS = 6000;

export interface VoiceViewDeps {
  session: VoiceSession;
  shadow: ShadowRoot;
  /** Target index to the element it names, when it is still on the page. */
  element: (target: number | null) => HTMLElement | null;
  /** A short name for where a comment is ("Goal bar", "Done chip"). */
  name: (target: number | null) => string;
  /** The clip's URL, made absolute against the server. */
  clipUrl: (clip: string) => string;
  onMove: (key: string) => void;
  now?: () => number;
}

/** `#t=12.4,31` → "0:19". */
export function clipLength(clip: string): string {
  const m = /#t=([\d.]+),([\d.]+)$/.exec(clip);
  const s = m ? Math.max(0, Math.round(Number(m[2]) - Number(m[1]))) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class VoiceView {
  readonly live: HTMLDivElement;
  private lead: HTMLDivElement;
  /** On a phone, the outline round the element the live card is about. */
  private mark: HTMLDivElement;
  /** On a phone after Stop, the card being read; null for the newest. */
  private page: string | null = null;
  private cards = new Map<string, { el: HTMLDivElement; until: number; html: string }>();
  private settled = new Set<string>();
  /** Notes whose raw words are shown in full. */
  private rawOpen = new Set<string>();
  /** A phone's dots on earlier notes' elements while recording. */
  private dots: HTMLDivElement;
  private raf: number | null = null;
  /** When the last recording stopped; a phone shows its newest card after. */
  private stoppedAt = Number.NEGATIVE_INFINITY;
  private wasRecording = false;
  /** The comment Move is choosing a place for. */
  picking: string | null = null;
  private audio: HTMLAudioElement | null = null;

  constructor(private readonly deps: VoiceViewDeps) {
    this.live = document.createElement('div');
    this.live.className = 'vlive float';
    this.live.hidden = true;
    this.live.setAttribute('aria-live', 'polite');
    this.live.innerHTML =
      '<div class="vhead"><span class="vdot"></span>' +
      '<span class="vwhere"></span><button class="vmove" type="button">Move</button></div>' +
      '<div class="vpol"></div><div class="vraw"><span></span></div>' +
      '<button class="vkept" type="button"></button>';
    this.lead = document.createElement('div');
    this.lead.className = 'vlead';
    this.mark = document.createElement('div');
    this.mark.className = 'vhl';
    this.mark.hidden = true;
    this.dots = document.createElement('div');
    const style = document.createElement('style');
    style.textContent = VOICE_CSS;
    deps.shadow.append(style, this.lead, this.mark, this.dots, this.live);
    this.dots.addEventListener('click', (ev) => {
      const key = (ev.target as HTMLElement).closest<HTMLElement>('.vpin')?.dataset.key;
      if (key) deps.session.reopen(key);
    });
    // A tap anywhere else, once recording has stopped, puts the cards away.
    document.addEventListener(
      'pointerdown',
      (ev) => {
        if (deps.session.state !== 'idle' || this.picking) return;
        const onCard = ev
          .composedPath()
          .some((n) => n instanceof HTMLElement && n.classList.contains('vcard'));
        if (!onCard) this.dismiss();
      },
      true,
    );
    this.live.querySelector('.vmove')?.addEventListener('click', () => {
      const open = this.openComment();
      if (open) deps.onMove(open.key);
    });
    const toggleRaw = () => {
      const open = this.openComment();
      if (!open) return;
      if (!this.rawOpen.delete(open.key)) this.rawOpen.add(open.key);
      this.render();
    };
    this.live.querySelector('.vpol')?.addEventListener('click', toggleRaw);
    this.live.querySelector('.vkept')?.addEventListener('click', toggleRaw);
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The note the live card is showing: one tapped to add to, or else the
   *  newest one still growing. */
  openComment(): VoiceComment | null {
    let open: VoiceComment | null = null;
    for (const c of this.deps.session.comments.values()) {
      if (c.reopening) return c;
      if (!c.final) open = c;
    }
    return open;
  }

  /** Every settled card off the screen. The comments stay, as pins. */
  dismiss(): void {
    for (const card of this.cards.values()) card.el.remove();
    this.cards.clear();
    this.lead.dataset.p = '';
    this.lead.innerHTML = '';
  }

  render(): void {
    const s = this.deps.session;
    const recording = s.state !== 'idle';
    if (this.wasRecording && !recording) this.stoppedAt = this.now;
    if (this.wasRecording !== recording) this.page = null;
    this.wasRecording = recording;
    const open = this.openComment();
    this.live.hidden = !recording && !this.picking;
    const target = this.picking
      ? (s.comments.get(this.picking)?.target ?? null)
      : open
        ? open.target
        : (s.pinned ?? null);
    const attached = target !== null && this.deps.element(target) !== null;
    const hearing = s.pending.trim() !== '';
    const noted = !!open?.text;
    this.live.className = `vlive ${attached ? 'attached' : 'float'}${this.picking ? ' picking' : ''}${hearing ? ' hearing' : ' quiet'}${noted ? ' noted' : ''}`;
    const where = this.live.querySelector('.vwhere') as HTMLElement;
    where.textContent = this.picking
      ? 'Tap where this belongs'
      : s.state === 'connecting'
        ? 'Starting…'
        : attached
          ? this.deps.name(target)
          : 'Listening…';
    where.classList.toggle('seeking', !this.picking && !attached);
    (this.live.querySelector('.vpol') as HTMLElement).textContent = open?.text ?? '';
    (this.live.querySelector('.vraw span') as HTMLElement).textContent = s.pending;
    const kept = this.live.querySelector('.vkept') as HTMLElement;
    kept.textContent = open?.raw ? `“${open.raw}”` : '';
    kept.classList.toggle('open', !!open && this.rawOpen.has(open.key));
    // Every new card first, so each one's pager knows them all.
    for (const c of s.comments.values()) this.makeCard(c);
    for (const c of s.comments.values()) this.drawCard(c);
    // Placed now as well as next frame: a card just attached has lost the
    // floating position and has no other until it is placed.
    if (this.place()) this.schedule();
  }

  private makeCard(c: VoiceComment): void {
    // A note tapped to add to is the live card's again: its card goes, and
    // comes back when it settles.
    if ((!c.final || c.reopening) && this.settled.delete(c.key)) {
      this.cards.get(c.key)?.el.remove();
      this.cards.delete(c.key);
    }
    // A card is made once, when its comment settles. One put away stays
    // away: the comment is its pin now, and a render comes with every word.
    if (!c.final || c.reopening || this.settled.has(c.key)) return;
    this.settled.add(c.key);
    const el = document.createElement('div');
    el.className = 'vcard';
    el.dataset.key = c.key;
    this.deps.shadow.append(el);
    this.cards.set(c.key, { el, until: Number.NEGATIVE_INFINITY, html: '' });
    this.wireCard(c.key, el);
  }

  /** The cards from the recording that said `key`, which its pager steps through. */
  private sameTake(key: string): string[] {
    const take = this.deps.session.comments.get(key)?.take;
    return [...this.cards.keys()].filter((k) => this.deps.session.comments.get(k)?.take === take);
  }

  private drawCard(c: VoiceComment): void {
    const card = this.cards.get(c.key);
    if (!c.final || !card) return;
    const el = card.el;
    const rawOpen = el.querySelector('.vrawtext')?.hasAttribute('hidden') === false;
    el.classList.toggle('undone', c.resolved === true);
    const keys = this.sameTake(c.key);
    const at = keys.indexOf(c.key) + 1;
    const html =
      `<div class="vtext">${escape(c.text)}</div>` +
      `<div class="vrawtext"${rawOpen ? '' : ' hidden'}>“${escape(c.raw)}”</div>` +
      '<div class="vfoot">' +
      (c.clip ? `<button type="button" class="vplay">▶ ${clipLength(c.clip)}</button>` : '') +
      '<button type="button" class="vrawbtn">Raw words</button>' +
      // A phone shows one card at a time after Stop; these step through the rest.
      (keys.length > 1
        ? `<span class="vpager"><button type="button" class="vprev" aria-label="Earlier comment"${at === 1 ? ' disabled' : ''}>‹</button><button type="button" class="vnext" aria-label="Later comment"${at === keys.length ? ' disabled' : ''}>›</button></span>`
        : '') +
      (c.posted
        ? `<button type="button" class="vundo">${c.resolved ? 'Redo' : 'Undo'}</button>`
        : '') +
      '</div>';
    // Rewritten only when it changed: a render comes with every word heard,
    // and a button replaced between press and release never gets its click.
    if (card.html !== html) {
      card.html = html;
      el.innerHTML = html;
    }
  }

  private wireCard(key: string, el: HTMLDivElement): void {
    // Kept up while the person is reading or reaching for it.
    el.addEventListener('pointerenter', () => {
      const card = this.cards.get(key);
      if (card) card.until = Number.POSITIVE_INFINITY;
    });
    el.addEventListener('pointerleave', () => {
      const card = this.cards.get(key);
      if (card) card.until = this.now + SETTLED_MS;
    });
    el.addEventListener('click', (ev) => {
      const b = (ev.target as Element).closest('button');
      const c = this.deps.session.comments.get(key);
      if (!c) return;
      if (!b) {
        // While talking, a tap on a note adds to it; after, a tap on its words shows the raw ones.
        if (this.deps.session.state !== 'idle') this.deps.session.reopen(key);
        else if ((ev.target as Element).closest('.vtext'))
          el.querySelector('.vrawtext')?.toggleAttribute('hidden');
        return;
      }
      if (b.classList.contains('vplay')) this.play(c.clip);
      else if (b.classList.contains('vrawbtn'))
        el.querySelector('.vrawtext')?.toggleAttribute('hidden');
      else if (b.classList.contains('vundo')) void this.deps.session.setResolved(key, !c.resolved);
      else if (b.classList.contains('vprev') || b.classList.contains('vnext')) {
        const keys = this.sameTake(key);
        const to = keys[keys.indexOf(key) + (b.classList.contains('vprev') ? -1 : 1)];
        const next = to === undefined ? undefined : this.cards.get(to);
        if (to && next) {
          this.page = to;
          next.until = this.now + SETTLED_MS;
          this.schedule();
        }
      }
      const card = this.cards.get(key);
      if (card) card.until = Math.max(card.until, this.now + SETTLED_MS);
    });
  }

  /** On a phone while talking, a dot on the element of each earlier note of this recording. */
  private drawDots(on: boolean): void {
    const s = this.deps.session;
    const notes = on
      ? [...this.cards.keys()].flatMap((key) => {
          const c = s.comments.get(key);
          const el = c?.take === s.recording ? this.deps.element(c.target) : null;
          return c && el ? [{ key, el }] : [];
        })
      : [];
    const keys = notes.map((n) => n.key).join(' ');
    if (this.dots.dataset.keys !== keys) {
      this.dots.dataset.keys = keys;
      this.dots.innerHTML = notes
        .map(
          (n) =>
            `<button class="vpin" type="button" data-key="${escape(n.key)}" aria-label="${escape(this.deps.name(s.comments.get(n.key)?.target ?? null))}"></button>`,
        )
        .join('');
    }
    notes.forEach(({ el }, i) => {
      const r = el.getBoundingClientRect();
      const dot = this.dots.children[i] as HTMLElement;
      Object.assign(dot.style, { left: `${r.right - 8}px`, top: `${r.top - 6}px` });
    });
  }

  private play(clip: string): void {
    this.audio?.pause();
    this.audio = new Audio(this.deps.clipUrl(clip));
    void this.audio.play().catch(() => {});
  }

  private schedule(): void {
    if (this.raf !== null) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      if (this.place()) this.schedule();
    });
  }

  /** Stand every card where it belongs; true while anything is still up. */
  place(): boolean {
    const vv = window.visualViewport;
    const left = vv?.offsetLeft ?? 0;
    const top = (vv?.offsetTop ?? 0) + 8;
    const width = vv ? vv.width : innerWidth;
    // The column ends above the mic, the highest of the buttons, wherever it
    // stands: reserving a fixed height left 190px empty above them at 1180.
    const mic = this.deps.shadow.querySelector('.fab-mic')?.getBoundingClientRect();
    const room =
      (mic?.height ? mic.top : (vv ? vv.offsetTop + vv.height : innerHeight) - BUTTONS_H) - 8;
    const phone = isPhoneFace();
    const x = left + width - 16 - CARD_W;
    const s = this.deps.session;
    const spots: Array<{ el: HTMLElement; r: DOMRect | undefined; h: number; want: number }> = [];
    const spot = (el: HTMLElement, target: HTMLElement | null) => {
      const h = el.offsetHeight;
      const r = target?.getBoundingClientRect();
      const want = !r
        ? top + 64
        : !phone && r.right + 12 <= x
          ? r.top
          : r.bottom + 8 + h <= room
            ? r.bottom + 8
            : r.top - 8 - h;
      spots.push({ el, r, h, want });
    };
    const liveTarget = this.picking
      ? (s.comments.get(this.picking)?.target ?? null)
      : (this.openComment()?.target ?? s.pinned ?? null);
    const docked = phone && !this.live.hidden && this.live.classList.contains('attached');
    if (docked) {
      // A phone has no room beside the page: the live card rests above the
      // buttons, or at the top when that would cover the element it names,
      // rather than lying across the rows under it.
      const h = this.live.offsetHeight;
      const r = this.deps.element(liveTarget)?.getBoundingClientRect();
      const covers = (y: number) =>
        r ? Math.max(0, Math.min(y + h, r.bottom) - Math.max(y, r.top)) : 0;
      const y = covers(room - h) > covers(top) ? top : room - h;
      Object.assign(this.live.style, { top: `${y}px`, bottom: 'auto', left: '', right: '' });
      // With the card that far from its element, the element says it is the one.
      if (r) {
        Object.assign(this.mark.style, {
          left: `${r.left - 3}px`,
          top: `${r.top - 3}px`,
          width: `${r.width + 6}px`,
          height: `${r.height + 6}px`,
        });
      }
      this.mark.hidden = !r;
    } else if (!this.live.hidden && this.live.classList.contains('attached')) {
      this.mark.hidden = true;
      spot(this.live, this.deps.element(liveTarget));
    } else {
      this.mark.hidden = true;
      // Floating: the stylesheet stands it above the buttons.
      Object.assign(this.live.style, { top: '', bottom: '', left: '', right: '' });
    }
    // Newest first, so when the column runs out of room it is the oldest
    // cards that wait behind their pins. A desktop card stays until a tap
    // elsewhere puts them away; a phone has no column beside the page, so
    // while recording its cards are pins only, and after Stop one card shows
    // for a moment — the newest, or the one its pager stepped to.
    const recording = s.state !== 'idle';
    const read =
      this.page !== null && this.cards.has(this.page) ? this.page : [...this.cards.keys()].at(-1);
    const reading = read === undefined ? undefined : this.cards.get(read);
    if (
      phone &&
      !recording &&
      reading &&
      Math.max(reading.until, this.stoppedAt + SETTLED_MS) < this.now
    ) {
      this.dismiss();
    }
    for (const [key, card] of [...this.cards].reverse()) {
      card.el.classList.toggle('paged', phone);
      if (phone && (recording || key !== read)) {
        card.el.hidden = true;
        continue;
      }
      card.el.hidden = false;
      spot(card.el, this.deps.element(s.comments.get(key)?.target ?? null));
    }
    this.drawDots(phone && recording);
    const ys = stackColumn(spots, top, room);
    let lines = '';
    spots.forEach(({ el, r, h }, i) => {
      const y = ys[i];
      el.hidden = y === null;
      if (y === null || y === undefined) return;
      Object.assign(el.style, { top: `${y}px`, bottom: 'auto' });
      Object.assign(el.style, phone ? { left: '', right: '' } : { left: `${x}px`, right: 'auto' });
      if (!phone && r && r.right + 12 <= x) {
        lines += `<line x1="${r.right + 2}" y1="${r.top + Math.min(r.height / 2, 14)}" x2="${x}" y2="${y + Math.min(h / 2, 16)}"/>`;
      }
    });
    if (this.lead.dataset.p !== lines) {
      this.lead.dataset.p = lines;
      this.lead.innerHTML = `<svg>${lines}</svg>`;
    }
    return !this.live.hidden || this.cards.size > 0;
  }
}
