import { beforeEach, describe, expect, it } from 'vitest';
import { wireDocRename } from '../src/doc/doc-rename.ts';

/**
 * Renaming a doc from its own title in the topbar.
 *
 * A meeting is born named after the clock, and until this existed no screen
 * could change that — so a project's meetings list was a column of timestamps
 * a week later. The affordance is the title itself, which makes two things
 * worth pinning: the editor opens from the FULL title rather than from the
 * abbreviated crumb on screen, and a refused rename puts the old label back
 * instead of leaving the page claiming a name the server does not hold.
 */
describe('wireDocRename', () => {
  let titleEl: HTMLElement;
  /** Every PUT the field made: the url it went to and the title it carried. */
  let sent: Array<{ url: string; title: string }>;
  let renamed: string[];
  let answer: boolean;

  const wire = (over: Partial<Parameters<typeof wireDocRename>[0]> = {}) =>
    wireDocRename({
      titleEl,
      docId: 'd-tide',
      canWrite: true,
      currentTitle: () => 'Meeting notes 2026-09-11 14:05',
      onRenamed: (t) => renamed.push(t),
      send: async (url, title) => {
        sent.push({ url, title });
        return answer;
      },
      ...over,
    });

  const field = (): HTMLInputElement => {
    const input = titleEl.querySelector('input');
    if (!input) throw new Error('no editor is open');
    return input as HTMLInputElement;
  };
  const press = (key: string): void => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  };
  /** Let the commit's promise settle before reading the DOM. */
  const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    titleEl = document.createElement('h1');
    // What the crumb SHOWS is shorter than the title — the kind word is
    // dropped once the page already says it is a meeting.
    titleEl.textContent = '2026-09-11 14:05';
    document.body.replaceChildren(titleEl);
    sent = [];
    renamed = [];
    answer = true;
  });

  it('opens on a click, seeded with the full title rather than the crumb', () => {
    wire();
    titleEl.click();
    expect(field().value).toBe('Meeting notes 2026-09-11 14:05');
    expect(field().maxLength).toBe(200);
  });

  it('commits on Enter, collapsing the whitespace the server would', async () => {
    wire();
    titleEl.click();
    field().value = '  Saltmarsh   tide walk  ';
    press('Enter');
    await settled();

    expect(sent).toEqual([{ url: sent[0]?.url ?? '', title: 'Saltmarsh tide walk' }]);
    expect(sent[0]?.url).toContain('docs/d-tide/title');
    expect(renamed).toEqual(['Saltmarsh tide walk']);
    expect(titleEl.textContent).toBe('Saltmarsh tide walk');
    expect(titleEl.querySelector('input')).toBeNull();
  });

  it('commits when the reader clicks away', async () => {
    wire();
    titleEl.click();
    field().value = 'Harborlight retro';
    field().dispatchEvent(new FocusEvent('blur'));
    await settled();
    expect(sent.map((s) => s.title)).toEqual(['Harborlight retro']);
  });

  it('cancels on Escape, sending nothing and restoring the crumb', async () => {
    wire();
    titleEl.click();
    field().value = 'Never meant it';
    press('Escape');
    await settled();
    expect(sent).toEqual([]);
    expect(renamed).toEqual([]);
    expect(titleEl.textContent).toBe('2026-09-11 14:05');
  });

  it('treats a blank field and an unchanged title as nothing to do', async () => {
    wire();
    titleEl.click();
    field().value = '   ';
    press('Enter');
    await settled();
    expect(sent).toEqual([]);
    expect(titleEl.textContent).toBe('2026-09-11 14:05');

    titleEl.click();
    press('Enter');
    await settled();
    expect(sent).toEqual([]);
  });

  it('puts the old label back when the server refuses', async () => {
    answer = false;
    wire();
    titleEl.click();
    field().value = 'Refused name';
    press('Enter');
    await settled();
    // It asked, it was told no, and the page went back to what is true.
    expect(sent.map((s) => s.title)).toEqual(['Refused name']);
    expect(renamed).toEqual([]);
    expect(titleEl.textContent).toBe('2026-09-11 14:05');
  });

  it('gives a reader who cannot write no editor and no affordance', () => {
    wire({ canWrite: false });
    titleEl.click();
    expect(titleEl.querySelector('input')).toBeNull();
    expect(titleEl.classList.contains('doc-title-editable')).toBe(false);
    expect(titleEl.getAttribute('role')).toBeNull();
    // Positive control: the same wiring with the seat opens one.
    wire();
    titleEl.click();
    expect(titleEl.querySelector('input')).not.toBeNull();
    expect(titleEl.getAttribute('role')).toBe('button');
  });

  it('opens from the keyboard, so the affordance is not mouse-only', () => {
    wire();
    titleEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(titleEl.querySelector('input')).not.toBeNull();
  });

  it('stays shut while its request is in flight, so a slow rename loses nothing', async () => {
    let answerThe: ((ok: boolean) => void) | null = null;
    wire({ send: (_url, _title) => new Promise<boolean>((r) => (answerThe = r)) });
    titleEl.click();
    field().value = 'Riverbend winter plan';
    press('Enter');
    await settled();

    // The name is on screen and the editor is gone, but a click cannot open a
    // second one: the answer to the first request is still coming, and it
    // would tear the second editor out from under whoever was typing in it.
    expect(titleEl.textContent).toBe('Riverbend winter plan');
    titleEl.click();
    expect(titleEl.querySelector('input')).toBeNull();

    (answerThe as unknown as (ok: boolean) => void)(true);
    await settled();
    // Settled, so the field opens again — the positive control on the lock.
    titleEl.click();
    expect(titleEl.querySelector('input')).not.toBeNull();
  });

  it('sends one request when the commit races its own blur', async () => {
    wire();
    titleEl.click();
    const input = field();
    input.value = 'Riverbend winter plan';
    press('Enter');
    input.dispatchEvent(new FocusEvent('blur'));
    await settled();
    expect(sent).toHaveLength(1);
  });
});
