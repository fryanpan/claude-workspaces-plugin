/**
 * "Start a meeting": the two-step wizard the lead chat opens over the page.
 *
 *   1. Notes — an existing doc (a filter over the board's docs, starting on
 *      the doc this page shows), a new doc with an editable name, or none.
 *   2. Recording — the source (this device's microphone, the microphone plus
 *      this Mac's audio, or a bot sent into a Zoom or Google Meet call) and
 *      the speakers (just me, or several voices with labels).
 *
 * Every billed choice is made here, before anything records, because a
 * transcription session's configuration is fixed once it opens. The chat panel has no
 * settings of its own.
 *
 * Escape, Cancel and a tap on the scrim close it with nothing started. Drawn
 * into the chat's own shadow root, so no page's stylesheet reaches it.
 */
import type { LeadChatMeetingSource, LeadChatNotesKind } from '@claude-workspaces/core/lead-chat';

export interface WizardDoc {
  docId: string;
  title: string;
}

export interface WizardChoice {
  notes: LeadChatNotesKind;
  /** The picked doc, for `existing`. */
  doc?: WizardDoc;
  /** The new doc's name, for `new`. */
  name?: string;
  source: LeadChatMeetingSource;
  speakers: 'solo' | 'conversation';
  /** The call a bot is sent into, for `bot`. */
  botUrl?: string;
}

export interface WizardOpts {
  document: Document;
  /** The shadow root the wizard draws into. */
  root: ShadowRoot;
  /** The board's docs, newest first; read when the wizard opens. */
  loadDocs: () => Promise<WizardDoc[]>;
  /** The doc this page shows, which step 1 starts on. */
  hereDocId?: string;
  /** Offer "Mac Audio": the browser can share its audio. */
  macAudio: boolean;
  /** Today, for the new doc's default name. */
  today?: Date;
  /** Start pressed. Called inside the tap, so it may open a microphone. */
  onStart: (choice: WizardChoice) => void;
  onClose?: () => void;
}

export interface Wizard {
  readonly open: boolean;
  show(): void;
  close(): void;
  destroy(): void;
}

export const WIZARD_STYLES = `
.lc-wiz-scrim { position: fixed; inset: 0; z-index: 2147483002; background: rgba(27,31,35,.28); display: grid; place-items: center; padding: 16px; }
.lc-wiz { width: 440px; max-width: 100%; max-height: calc(100dvh - 32px); overflow-y: auto; background: var(--bg, #fff); border-radius: 12px; box-shadow: 0 16px 40px rgba(0,0,0,.22); padding: 18px 20px; font-size: 14px; line-height: 1.4; color: var(--fg, #1b1f23); }
.lc-wiz h2 { font-size: 17px; margin: 0; }
.lc-wiz-step { margin: 2px 0 6px; font-size: 13px; color: var(--fg-muted, #57606a); }
.lc-wiz-keep { margin: 0 0 12px; font-size: 13.5px; min-height: 2.8em; }
.lc-wiz-h { margin: 12px 0 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #8a8780; }
.lc-wiz-opt { display: flex; gap: 10px; align-items: flex-start; padding: 9px 11px; margin-bottom: 6px; border: 1px solid #e5e0d6; border-radius: 8px; cursor: pointer; }
.lc-wiz-opt.is-on { border-color: #c96442; }
.lc-wiz-opt input[type="radio"] { margin: 3px 0 0; accent-color: #c96442; flex: none; }
.lc-wiz-opt > span { flex: 1; min-width: 0; }
.lc-wiz-opt b { display: block; font-weight: 600; }
.lc-wiz-note { display: block; font-size: 12.5px; color: #8a8780; }
.lc-wiz-field { display: block; width: 100%; height: 36px; margin-top: 8px; padding: 0 8px; border: 1px solid var(--border, #d0d7de); border-radius: 6px; font: inherit; font-size: 16px; background: var(--bg, #fff); color: inherit; }
.lc-wiz-docs { display: flex; flex-direction: column; margin-top: 6px; max-height: 176px; overflow-y: auto; border: 1px solid #e5e0d6; border-radius: 6px; }
.lc-wiz-docs button { flex: none; min-height: 36px; padding: 0 10px; border: 0; border-top: 1px solid #f0ece0; background: var(--bg, #fff); text-align: left; font: inherit; cursor: pointer; color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lc-wiz-docs button:first-child { border-top: 0; }
.lc-wiz-docs button[aria-selected="true"] { background: #f0ece0; font-weight: 600; }
.lc-wiz-docs .lc-wiz-note { padding: 8px 10px; }
.lc-wiz-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.lc-wiz-acts button { min-width: 6.5em; height: 40px; padding: 0 14px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; }
.lc-wiz-ghost { border: 1px solid var(--border, #d1d5da); background: var(--bg, #fff); color: inherit; }
.lc-wiz-ink { border: 1px solid #1a1a18; background: #1a1a18; color: #fff; }
.lc-wiz-ink:disabled { opacity: .5; cursor: default; }
@media (max-width: 1100px) { .lc-wiz-scrim { place-items: end center; padding: 0; } .lc-wiz { width: 100%; border-radius: 14px 14px 0 0; padding-bottom: calc(18px + env(safe-area-inset-bottom, 0px)); } }
`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Meeting notes, 29 Oct": the new doc's name until the person changes it. */
export function defaultNotesName(d: Date): string {
  return `Meeting notes, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The docs a filter keeps: every word of it, in any order, in the title. */
export function filterDocs(docs: readonly WizardDoc[], filter: string): WizardDoc[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  return docs.filter((d) => words.every((w) => d.title.toLowerCase().includes(w)));
}

interface WizState {
  step: 1 | 2;
  kind: LeadChatNotesKind;
  docs: WizardDoc[] | null;
  doc: WizardDoc | null;
  filter: string;
  name: string;
  source: LeadChatMeetingSource;
  speakers: 'solo' | 'conversation';
  botUrl: string;
}

export function createWizard(opts: WizardOpts): Wizard {
  const doc = opts.document;
  const scrim = doc.createElement('div');
  scrim.className = 'lc-wiz-scrim';
  scrim.hidden = true;
  const style = doc.createElement('style');
  style.textContent = WIZARD_STYLES;
  opts.root.append(style, scrim);
  let st: WizState | null = null;

  const esc = (t: string): string =>
    t.replace(
      /[&<>"]/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch,
    );
  const opt = (
    name: string,
    value: string,
    current: string,
    title: string,
    note: string,
    extra = '',
  ): string =>
    `<label class="lc-wiz-opt${current === value ? ' is-on' : ''}"><input type="radio" name="${name}" value="${value}"${current === value ? ' checked' : ''}><span><b>${title}</b><span class="lc-wiz-note">${note}</span>${current === value ? extra : ''}</span></label>`;

  const canNext = (s: WizState): boolean =>
    s.kind === 'existing' ? s.doc !== null : s.kind === 'new' ? s.name.trim() !== '' : true;
  const canStart = (s: WizState): boolean =>
    s.source !== 'bot' || /^https?:\/\/\S+$/.test(s.botUrl.trim());

  const render = (): void => {
    scrim.hidden = !st;
    if (!st) {
      scrim.replaceChildren();
      return;
    }
    const s = st;
    let body: string;
    if (s.step === 1) {
      const shown = s.docs ? filterDocs(s.docs, s.filter) : null;
      const list =
        shown === null
          ? '<span class="lc-wiz-note">Loading the docs…</span>'
          : shown.length === 0
            ? '<span class="lc-wiz-note">No doc matches.</span>'
            : shown
                .map(
                  (d) =>
                    `<button type="button" role="option" data-wiz-doc="${esc(d.docId)}" aria-selected="${d.docId === s.doc?.docId}">${esc(d.title)}</button>`,
                )
                .join('');
      const picker = `<input type="search" class="lc-wiz-field" data-wiz="filter" value="${esc(s.filter)}" placeholder="Find a doc" aria-label="Find a doc"><span class="lc-wiz-docs" role="listbox" aria-label="Docs">${list}</span>`;
      const name = `<input type="text" class="lc-wiz-field" data-wiz="name" value="${esc(s.name)}" aria-label="New doc name" maxlength="120">`;
      body = `<p class="lc-wiz-step">Step 1 of 2 · Notes</p>
        <p class="lc-wiz-keep">${s.kind === 'none' ? 'Nothing is written down. The meeting runs until you press End meeting.' : 'The note taker keeps taking notes wherever you go in the workspace, until you press End meeting.'}</p>
        ${opt('wk', 'existing', s.kind, 'In an existing doc', 'The note taker adds to a doc you pick.', picker)}
        ${opt('wk', 'new', s.kind, 'In a new doc', 'A new doc in the Library.', name)}
        ${opt('wk', 'none', s.kind, 'No notes', 'Nothing is written down.')}
        <div class="lc-wiz-acts"><button type="button" class="lc-wiz-ghost" data-wiz="cancel">Cancel</button><button type="button" class="lc-wiz-ink" data-wiz="next"${canNext(s) ? '' : ' disabled'}>Next</button></div>`;
    } else {
      const link = `<input type="url" class="lc-wiz-field" data-wiz="bot" value="${esc(s.botUrl)}" placeholder="Paste the meeting link" aria-label="Meeting link for the bot to join">`;
      body = `<p class="lc-wiz-step">Step 2 of 2 · Recording</p>
        <p class="lc-wiz-h">Source</p>
        ${opt('ws', 'mic', s.source, 'Use microphone', 'Record the room from this device')}
        ${opts.macAudio ? opt('ws', 'mix', s.source, 'Mac Audio', 'Microphone plus what this Mac plays. Chrome asks what to share.') : ''}
        ${opt('ws', 'bot', s.source, 'Join Zoom / Google Meet', 'A bot joins the call and records it', link)}
        <p class="lc-wiz-h">Speakers</p>
        ${opt('wp', 'solo', s.speakers, 'Just me', 'No speaker labels')}
        ${opt('wp', 'conversation', s.speakers, 'Multiple Speakers', 'Labels each voice')}
        <div class="lc-wiz-acts"><button type="button" class="lc-wiz-ghost" data-wiz="back">Back</button><button type="button" class="lc-wiz-ink" data-wiz="start"${canStart(s) ? '' : ' disabled'}>Start meeting</button></div>`;
    }
    scrim.innerHTML = `<div class="lc-wiz" role="dialog" aria-modal="true" aria-labelledby="lc-wiz-t"><h2 id="lc-wiz-t">Start a meeting</h2>${body}</div>`;
  };

  const focus = (sel: string): void => {
    const el = scrim.querySelector<HTMLElement>(sel);
    el?.focus();
  };

  const close = (): void => {
    if (!st) return;
    st = null;
    render();
    opts.onClose?.();
  };

  scrim.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (!st) return;
    if (t.name === 'wk') st.kind = t.value as LeadChatNotesKind;
    else if (t.name === 'ws') st.source = t.value as LeadChatMeetingSource;
    else if (t.name === 'wp') st.speakers = t.value as 'solo' | 'conversation';
    else return;
    render();
    focus(`input[name="${t.name}"][value="${t.value}"]`);
  });
  scrim.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (!st) return;
    const keep = (): void => {
      const pos = t.selectionStart ?? t.value.length;
      render();
      const f = scrim.querySelector<HTMLInputElement>(`[data-wiz="${t.dataset.wiz}"]`);
      f?.focus();
      f?.setSelectionRange(pos, pos);
    };
    if (t.dataset.wiz === 'filter') {
      st.filter = t.value;
      keep();
    } else if (t.dataset.wiz === 'name') {
      st.name = t.value;
      keep();
    } else if (t.dataset.wiz === 'bot') {
      st.botUrl = t.value;
      keep();
    }
  });
  scrim.addEventListener('click', (e) => {
    if (!st) return;
    if (e.target === scrim) {
      close();
      return;
    }
    const target = e.target as HTMLElement;
    const d = target.closest<HTMLElement>('[data-wiz-doc]');
    if (d) {
      st.doc = st.docs?.find((x) => x.docId === d.dataset.wizDoc) ?? null;
      render();
      return;
    }
    const b = target.closest<HTMLButtonElement>('button[data-wiz]');
    if (!b || b.disabled) return;
    const a = b.dataset.wiz;
    if (a === 'cancel') {
      close();
      return;
    }
    if (a === 'next') st.step = 2;
    else if (a === 'back') st.step = 1;
    else if (a === 'start') {
      const s = st;
      const choice: WizardChoice = {
        notes: s.kind,
        source: s.source,
        speakers: s.speakers,
        ...(s.kind === 'existing' && s.doc ? { doc: s.doc } : {}),
        ...(s.kind === 'new' ? { name: s.name.trim() } : {}),
        ...(s.source === 'bot' ? { botUrl: s.botUrl.trim() } : {}),
      };
      st = null;
      render();
      opts.onStart(choice);
      return;
    }
    render();
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && st) {
      e.stopPropagation();
      close();
    }
  };
  doc.addEventListener('keydown', onKey, true);

  return {
    get open() {
      return st !== null;
    },
    show() {
      st = {
        step: 1,
        kind: 'existing',
        docs: null,
        doc: null,
        filter: '',
        name: defaultNotesName(opts.today ?? new Date()),
        source: 'mic',
        speakers: 'conversation',
        botUrl: '',
      };
      render();
      const mine = st;
      void opts.loadDocs().then(
        (docs) => {
          if (st !== mine) return;
          mine.docs = docs;
          mine.doc = docs.find((d) => d.docId === opts.hereDocId) ?? docs[0] ?? null;
          // A board with no docs has nothing to pick: the new doc is the start.
          if (docs.length === 0) mine.kind = 'new';
          render();
        },
        () => {
          if (st !== mine) return;
          mine.docs = [];
          mine.kind = 'new';
          render();
        },
      );
    },
    close,
    destroy() {
      doc.removeEventListener('keydown', onKey, true);
      scrim.remove();
      style.remove();
    },
  };
}
