/**
 * The lead chat's composer: a tray of attached files, the field, and a row
 * with + , the model chip, the mic and send. Drawing only; what a tap does is
 * `lead-chat-composer-wiring.ts`.
 *
 * The chip shows what the lead's hooks report and opens nothing: switching from
 * the board is off (`server/src/lead-chat/lead-model.ts` says why). It is sized
 * for its widest label so the row never moves as the model changes. The sheet
 * rises inside the panel, over a scrim, so the chat stays where the reader
 * left it.
 */
import {
  type LeadEffort,
  type LeadModelState,
  leadModelLabel,
} from '@claude-workspaces/core/lead-chat';

const PLUS =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>';
const MIC =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="7" y="3" width="6" height="10" rx="3"/><path d="M4.5 10a5.5 5.5 0 0011 0M10 15.5V18"/></svg>';
const ARROW =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 16V4M5 9l5-5 5 5"/></svg>';
const CAMERA =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const PHOTO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l5-4 3 2 3-3 4 4"/></svg>';
const FILE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>';
const CLOSE =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>';

const EFFORT_LABEL: Record<LeadEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-high',
  max: 'Max',
};

/** One file in the tray. */
export interface TrayFile {
  key: string;
  name: string;
  /** "12 KB", or that it is still going up. */
  note: string;
  /** A local preview of an image. */
  preview?: string;
  /** Still going up; shown steady, dimmed, until it is stored. */
  uploading?: boolean;
}

export interface ComposerModel {
  files: readonly TrayFile[];
  sendable: boolean;
  listening: boolean;
  inMeeting: boolean;
  leadModel: LeadModelState;
}

/** The composer of a view drawn with no attachments or model to show. */
export const bareComposer = (field: HTMLTextAreaElement, listening: boolean): ComposerModel => ({
  files: [],
  sendable: field.value.trim() !== '',
  listening,
  inMeeting: false,
  leadModel: {},
});

export type ComposerSheet = 'add' | null;

export interface Composer {
  root: HTMLElement;
  field: HTMLTextAreaElement;
  send: HTMLButtonElement;
  plus: HTMLButtonElement;
  chip: HTMLElement;
  mic: HTMLButtonElement;
  tray: HTMLElement;
  camera: HTMLInputElement;
  photos: HTMLInputElement;
  files: HTMLInputElement;
  /** Everything that sits on top of the panel, for the panel to hold. */
  overlays: readonly HTMLElement[];
  scrim: HTMLElement;
  /** Tiles and rows, wired once. */
  cameraTile: HTMLButtonElement;
  photosTile: HTMLButtonElement;
  filesTile: HTMLButtonElement;
  closers: readonly HTMLButtonElement[];
  sheet(which: ComposerSheet): void;
  openSheet(): ComposerSheet;
  render(m: ComposerModel): void;
}

function make<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function iconButton(doc: Document, cls: string, label: string, svg: string): HTMLButtonElement {
  const b = make(doc, 'button', cls);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = svg;
  return b;
}

function tile(doc: Document, label: string, svg: string): HTMLButtonElement {
  const b = make(doc, 'button', 'lc-tile');
  b.type = 'button';
  b.innerHTML = svg;
  b.append(label);
  return b;
}

function picker(doc: Document, accept?: string, capture?: string): HTMLInputElement {
  const i = make(doc, 'input');
  i.type = 'file';
  i.hidden = true;
  i.tabIndex = -1;
  if (accept) i.accept = accept;
  if (capture) i.setAttribute('capture', capture);
  else i.multiple = true;
  return i;
}

function sheetShell(doc: Document, label: string) {
  const sheet = make(doc, 'div', 'lc-rise');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', label);
  sheet.hidden = true;
  const head = make(doc, 'div', 'lc-rise-head');
  const close = iconButton(doc, 'lc-icon', 'Close', CLOSE);
  head.append(make(doc, 'h3', undefined, label), close);
  sheet.append(head);
  return { sheet, close };
}

/** What the chip shows: what the lead's hooks report it runs on. */
export function chipLabels(s: LeadModelState): { model: string; effort: string } {
  return {
    model: leadModelLabel(s.model) ?? 'Model',
    effort: EFFORT_LABEL[s.effort as LeadEffort] ?? '',
  };
}

export function createComposer(doc: Document): Composer {
  const root = make(doc, 'div', 'lc-compose');
  const box = make(doc, 'div', 'lc-box');
  const tray = make(doc, 'div', 'lc-tray');
  const field = make(doc, 'textarea');
  field.rows = 1;
  field.placeholder = 'Message lead agent';
  field.setAttribute('aria-label', 'Message lead agent');
  field.maxLength = 4000;
  const row = make(doc, 'div', 'lc-actions');
  const plus = iconButton(doc, 'lc-round', 'Add photos or files', PLUS);
  const chip = make(doc, 'div', 'lc-chip');
  chip.setAttribute('role', 'img');
  const chipModel = make(doc, 'span', undefined, 'Model');
  const chipEffort = make(doc, 'span', 'lc-eff');
  chip.append(chipModel, chipEffort);
  const mic = iconButton(doc, 'lc-round lc-mic', 'Talk', MIC);
  mic.setAttribute('aria-pressed', 'false');
  const send = iconButton(doc, 'lc-round lc-send', 'Send', ARROW);
  send.disabled = true;
  row.append(plus, chip, make(doc, 'span', 'lc-grow'), mic, send);
  box.append(tray, field, row);
  const camera = picker(doc, 'image/*', 'environment');
  const photos = picker(doc, 'image/*');
  const files = picker(doc);
  root.append(box, camera, photos, files);

  const scrim = make(doc, 'div', 'lc-scrim');
  scrim.hidden = true;

  const add = sheetShell(doc, 'Add context');
  const grid = make(doc, 'div', 'lc-tiles');
  const cameraTile = tile(doc, 'Camera', CAMERA);
  const photosTile = tile(doc, 'Photos', PHOTO);
  const filesTile = tile(doc, 'Add files', FILE);
  grid.append(cameraTile, photosTile, filesTile);
  add.sheet.append(grid);

  let open: ComposerSheet = null;
  const sheet = (which: ComposerSheet): void => {
    open = which;
    add.sheet.hidden = which !== 'add';
    scrim.hidden = which === null;
  };

  const drawTray = (list: readonly TrayFile[]): void => {
    tray.hidden = list.length === 0;
    const held = new Map([...tray.children].map((n) => [(n as HTMLElement).dataset.key, n]));
    for (const f of list) {
      const known = held.get(f.key);
      if (known) {
        known.classList.toggle('lc-att-up', f.uploading === true);
        const note = known.querySelector('.lc-att-note');
        if (note) note.textContent = f.note;
        held.delete(f.key);
        continue;
      }
      const chipEl = make(doc, 'div', f.preview ? 'lc-att' : 'lc-att lc-att-file');
      chipEl.dataset.key = f.key;
      chipEl.classList.toggle('lc-att-up', f.uploading === true);
      chipEl.title = f.name;
      if (f.preview) {
        const img = make(doc, 'img');
        img.src = f.preview;
        img.alt = f.name;
        chipEl.append(img);
      } else {
        chipEl.append(make(doc, 'b', undefined, f.name), make(doc, 'span', 'lc-att-note', f.note));
      }
      const x = make(doc, 'button', 'lc-att-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', `Remove ${f.name}`);
      x.dataset.remove = f.key;
      chipEl.append(x);
      tray.append(chipEl);
    }
    for (const gone of held.values()) gone.remove();
  };

  const render = (m: ComposerModel): void => {
    drawTray(m.files);
    send.disabled = !m.sendable;
    mic.setAttribute('aria-pressed', String(m.listening));
    mic.setAttribute('aria-label', m.listening ? 'Stop listening' : 'Talk');
    mic.disabled = m.inMeeting;
    const labels = chipLabels(m.leadModel);
    chipModel.textContent = labels.model;
    chipEffort.textContent = labels.effort;
    chip.setAttribute(
      'aria-label',
      `Lead model: ${labels.model}${labels.effort ? `, ${labels.effort} effort` : ''}`,
    );
  };

  return {
    root,
    field,
    send,
    plus,
    chip,
    mic,
    tray,
    camera,
    photos,
    files,
    overlays: [scrim, add.sheet],
    scrim,
    cameraTile,
    photosTile,
    filesTile,
    closers: [add.close],
    sheet,
    openSheet: () => open,
    render,
  };
}
