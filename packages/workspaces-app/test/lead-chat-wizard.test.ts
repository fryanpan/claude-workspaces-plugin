/**
 * "Start a meeting", the two-step wizard (`lead-chat-wizard.ts`): where the
 * notes go, then what records and who speaks. Driven by taps on a real DOM.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  type WizardChoice,
  type WizardDoc,
  createWizard,
  defaultNotesName,
  filterDocs,
} from '../src/lead-chat/lead-chat-wizard.ts';
import { flush } from './lead-chat-meeting-fakes.ts';

const DOCS: WizardDoc[] = [
  { docId: 'd-harbor', title: 'Harborlight plan' },
  { docId: 'd-salt', title: 'Saltmarsh survey notes' },
  { docId: 'd-river', title: 'Riverbend ferry times' },
];

let host: HTMLElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});

function open(opts: { docs?: WizardDoc[]; here?: string; macAudio?: boolean } = {}) {
  host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const started: WizardChoice[] = [];
  let closed = 0;
  const wizard = createWizard({
    document,
    root,
    loadDocs: async () => opts.docs ?? DOCS,
    ...(opts.here ? { hereDocId: opts.here } : {}),
    macAudio: opts.macAudio ?? true,
    today: new Date(2026, 9, 29),
    onStart: (c) => started.push(c),
    onClose: () => closed++,
  });
  wizard.show();
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const text = () => q('.lc-wiz')?.textContent ?? '';
  const tap = (sel: string) => {
    const el = q(sel);
    if (!el) throw new Error(`nothing at ${sel}`);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  };
  const pick = (name: string, value: string) => {
    const r = q<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
    if (!r) throw new Error(`no ${name}=${value}`);
    r.checked = true;
    r.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const type = (wiz: string, value: string) => {
    const f = q<HTMLInputElement>(`[data-wiz="${wiz}"]`);
    if (!f) throw new Error(`no field ${wiz}`);
    f.value = value;
    f.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return { wizard, root, q, text, tap, pick, type, started, closed: () => closed };
}

describe('the meeting wizard', () => {
  it('names a new doc for the day, and a filter keeps every word in any order', () => {
    expect(defaultNotesName(new Date(2026, 9, 29))).toBe('Meeting notes, 29 Oct');
    expect(filterDocs(DOCS, 'notes salt').map((d) => d.docId)).toEqual(['d-salt']);
    expect(filterDocs(DOCS, '')).toHaveLength(3);
  });

  it('starts on the doc this page shows, and a filter narrows the list', async () => {
    const w = open({ here: 'd-river' });
    await flush();
    expect(w.text()).toContain('Step 1 of 2 · Notes');
    expect(w.text()).toContain('The note taker keeps taking notes wherever you go');
    expect(w.q('[aria-selected="true"]')?.textContent).toBe('Riverbend ferry times');
    w.type('filter', 'harbor');
    expect([...w.root.querySelectorAll('[data-wiz-doc]')].map((b) => b.textContent)).toEqual([
      'Harborlight plan',
    ]);
    w.tap('[data-wiz-doc="d-harbor"]');
    w.tap('[data-wiz="next"]');
    expect(w.text()).toContain('Step 2 of 2 · Recording');
    w.tap('[data-wiz="start"]');
    expect(w.started).toEqual([
      { notes: 'existing', doc: DOCS[0], source: 'mic', speakers: 'conversation' },
    ]);
    expect(w.wizard.open).toBe(false);
  });

  it('a new doc carries its edited name; no notes says nothing is written down', async () => {
    const w = open();
    await flush();
    w.pick('wk', 'new');
    expect(w.q<HTMLInputElement>('[data-wiz="name"]')?.value).toBe('Meeting notes, 29 Oct');
    w.type('name', '  Ferry review  ');
    w.tap('[data-wiz="next"]');
    w.pick('wp', 'solo');
    w.tap('[data-wiz="start"]');
    expect(w.started[0]).toEqual({
      notes: 'new',
      name: 'Ferry review',
      source: 'mic',
      speakers: 'solo',
    });

    const n = open();
    await flush();
    n.pick('wk', 'none');
    expect(n.text()).toContain(
      'Nothing is written down. The meeting runs until you press End meeting.',
    );
  });

  it('a bot needs the call’s link before it can start', async () => {
    const w = open();
    await flush();
    w.tap('[data-wiz="next"]');
    w.pick('ws', 'bot');
    expect(w.q<HTMLButtonElement>('[data-wiz="start"]')?.disabled).toBe(true);
    w.type('bot', 'https://meet.example.test/abc-defg-hij');
    expect(w.q<HTMLButtonElement>('[data-wiz="start"]')?.disabled).toBe(false);
    w.tap('[data-wiz="back"]');
    expect(w.text()).toContain('Step 1 of 2');
    w.tap('[data-wiz="next"]');
    w.tap('[data-wiz="start"]');
    expect(w.started[0]).toMatchObject({
      source: 'bot',
      botUrl: 'https://meet.example.test/abc-defg-hij',
    });
  });

  it('offers Mac Audio only where the browser can share it', async () => {
    const w = open({ macAudio: false });
    await flush();
    w.tap('[data-wiz="next"]');
    expect(w.text()).not.toContain('Mac Audio');
    expect(w.text()).toContain('Use microphone');
    const m = open({ macAudio: true });
    await flush();
    m.tap('[data-wiz="next"]');
    expect(m.text()).toContain('Mac Audio');
  });

  it('Escape, Cancel and the scrim each close it with nothing started', async () => {
    const w = open();
    await flush();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(w.wizard.open).toBe(false);
    w.wizard.show();
    w.tap('[data-wiz="cancel"]');
    expect(w.wizard.open).toBe(false);
    w.wizard.show();
    w.tap('.lc-wiz-scrim');
    expect(w.wizard.open).toBe(false);
    expect(w.closed()).toBe(3);
    expect(w.started).toEqual([]);
  });

  it('a board with no docs starts on a new doc', async () => {
    const w = open({ docs: [] });
    await flush();
    expect(w.q<HTMLInputElement>('input[name="wk"][value="new"]')?.checked).toBe(true);
  });
});
