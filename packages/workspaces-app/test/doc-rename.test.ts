import { beforeEach, describe, expect, it } from 'vitest';
import { labelDirection, wireDocRename } from '../src/doc/doc-rename.ts';

/**
 * Renaming a doc from its own title in the topbar.
 *
 * A meeting is born named after the clock, and until this existed no screen
 * could change that — so a project's meetings list was a column of timestamps
 * a week later.
 *
 * The editing is the board's `wireWordsInPlace`, so what is worth pinning
 * here is the adapter around it: the editor opens from the FULL title rather
 * than from the abbreviated crumb on screen, a refused rename puts the crumb
 * back instead of leaving the page claiming a name the server does not hold,
 * a cancelled edit does the same, and the element becomes editable in place
 * rather than being swapped for a field of its own.
 */
describe('wireDocRename', () => {
  let titleEl: HTMLElement;
  /** Every PUT the field made: the url it went to and the title it carried. */
  let sent: Array<{ url: string; title: string }>;
  let renamed: string[];
  let redrawn: number;
  let answer: boolean;
  const CRUMB = '2026-09-11 14:05';
  const FULL = 'Meeting notes 2026-09-11 14:05';

  const wire = (over: Partial<Parameters<typeof wireDocRename>[0]> = {}) =>
    wireDocRename({
      titleEl,
      docId: 'd-tide',
      canWrite: true,
      currentTitle: () => FULL,
      onRenamed: (t) => renamed.push(t),
      // What the real caller does: repaint the crumb from what the doc says.
      redrawLabel: () => {
        redrawn += 1;
        titleEl.textContent = CRUMB;
      },
      send: async (url, title) => {
        sent.push({ url, title });
        return answer;
      },
      ...over,
    });

  const type = (text: string): void => {
    titleEl.textContent = text;
  };
  const press = (key: string, on: HTMLElement = titleEl): void => {
    on.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  };
  const editing = (): boolean => titleEl.hasAttribute('contenteditable');
  /** Let the commit's promise and the end-of-edit microtask settle. */
  const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    titleEl = document.createElement('span');
    titleEl.className = 'doc-path';
    // What the crumb SHOWS is shorter than the title — the kind word is
    // dropped once the page already says it is a meeting.
    titleEl.textContent = CRUMB;
    document.body.replaceChildren(titleEl);
    sent = [];
    renamed = [];
    redrawn = 0;
    answer = true;
  });

  it('edits the words where they are rather than swapping in a field', () => {
    wire();
    titleEl.click();
    // The board's mechanism: one attribute changes, the element and its box
    // are never replaced, so nothing can move as the edit opens.
    expect(editing()).toBe(true);
    expect(titleEl.querySelector('input')).toBeNull();
    expect(titleEl.tagName).toBe('SPAN');
  });

  it('opens seeded with the full title rather than the crumb', () => {
    wire();
    titleEl.click();
    expect(titleEl.textContent).toBe(FULL);
  });

  it('reads left to right while editing, whatever the crumb was doing', () => {
    wire();
    titleEl.click();
    expect(titleEl.dir).toBe('ltr');
    // A path keeps the truncate-from-the-start trick; a name never had one.
    expect(labelDirection('docs/architecture/overview.md')).toBe('rtl');
    expect(labelDirection(FULL)).toBe('ltr');
  });

  it('commits on Enter, trimming what was typed', async () => {
    wire();
    titleEl.click();
    type('  Saltmarsh tide walk  ');
    press('Enter');
    await settled();

    expect(sent.map((s) => s.title)).toEqual(['Saltmarsh tide walk']);
    expect(sent[0]?.url).toContain('docs/d-tide/title');
    expect(renamed).toEqual(['Saltmarsh tide walk']);
    expect(editing()).toBe(false);
    // The new name is on screen straight away, not after a round trip.
    expect(titleEl.textContent).toBe('Saltmarsh tide walk');
    expect(redrawn).toBe(0);
  });

  it('commits when the reader clicks away', async () => {
    wire();
    titleEl.click();
    type('Harborlight retro');
    titleEl.dispatchEvent(new FocusEvent('blur'));
    await settled();
    expect(sent.map((s) => s.title)).toEqual(['Harborlight retro']);
  });

  it('cancels on Escape, sending nothing and putting the crumb back', async () => {
    wire();
    titleEl.click();
    type('Never meant it');
    press('Escape');
    await settled();
    expect(sent).toEqual([]);
    expect(renamed).toEqual([]);
    // Not the full title it was seeded with — the abbreviation it had.
    expect(titleEl.textContent).toBe(CRUMB);
    expect(redrawn).toBe(1);
  });

  it('treats a blank field and an unchanged title as nothing to do', async () => {
    wire();
    titleEl.click();
    type('   ');
    press('Enter');
    await settled();
    expect(sent).toEqual([]);
    expect(titleEl.textContent).toBe(CRUMB);

    titleEl.click();
    press('Enter');
    await settled();
    expect(sent).toEqual([]);
    expect(titleEl.textContent).toBe(CRUMB);
  });

  it('puts the crumb back when the server refuses', async () => {
    answer = false;
    wire();
    titleEl.click();
    type('Refused name');
    press('Enter');
    await settled();
    // It asked, it was told no, and the page went back to what is true.
    expect(sent.map((s) => s.title)).toEqual(['Refused name']);
    expect(renamed).toEqual([]);
    expect(titleEl.textContent).toBe(CRUMB);
  });

  it('gives a reader who cannot write no editor and no affordance', () => {
    wire({ canWrite: false });
    titleEl.click();
    expect(editing()).toBe(false);
    expect(titleEl.classList.contains('doc-title-editable')).toBe(false);
    // Positive control: the same wiring with the seat opens one.
    wire();
    titleEl.click();
    expect(editing()).toBe(true);
    expect(titleEl.classList.contains('doc-title-editable')).toBe(true);
  });

  it('opens from the keyboard, so the affordance is not mouse-only', () => {
    wire();
    press('Enter');
    expect(editing()).toBe(true);
    expect(titleEl.textContent).toBe(FULL);
  });

  it('takes its listeners through the caller scope, so a second doc is not a second editor', () => {
    const taken: Array<{ type: string; handler: EventListener }> = [];
    wire({
      listen: (target, type_, handler) => {
        taken.push({ type: type_, handler });
        target.addEventListener(type_, handler);
      },
    });
    // Every listener this wiring installs passed through the scope — there is
    // nothing left for a navigation to fail to take away.
    expect(taken.map((t) => t.type).sort()).toEqual(['blur', 'click', 'keydown', 'keydown']);
    for (const t of taken) titleEl.removeEventListener(t.type, t.handler);
    titleEl.click();
    expect(editing()).toBe(false);
  });

  it('sends one request when the commit races its own blur', async () => {
    wire();
    titleEl.click();
    type('Riverbend winter plan');
    press('Enter');
    titleEl.dispatchEvent(new FocusEvent('blur'));
    await settled();
    expect(sent).toHaveLength(1);
  });
});
