/**
 * The level each person holds in "Who has access": an Owner changes it per
 * person and per `@domain` row from a select, Owner is asked in the row
 * first, and a member reads the same words as text.
 *
 * That the change reaches the person's open page is the browser test
 * (`board-role-browser.test.ts`); the route itself is
 * `packages/server/test/workspace-members-route.test.ts`.
 *
 * All fixtures are synthetic.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type AccessRole,
  type AccessWriteResult,
  type BoardMembersView,
  LEVEL_LEGEND,
  mountBoardMembers,
} from '../src/board/board-members.ts';

const BOB = 'bob@harborlight.example';
const SALT = 'saltmarsh@riverbend.example';
const DOMAIN = '@riverbend.example';
const DAY = Date.UTC(2026, 10, 20, 12);

const VIEW: BoardMembersView = {
  you: { email: null, role: 'owner', accessRole: 'owner' },
  audience: [
    { match: BOB, addedAt: DAY },
    { match: DOMAIN, addedAt: DAY, access: 'comment' },
  ],
  members: [
    { email: BOB, role: 'member', accessRole: 'view', addedAt: DAY, entry: BOB },
    { email: SALT, role: 'member', accessRole: 'comment', addedAt: DAY, entry: DOMAIN },
  ],
};

function mount(
  opts: {
    view?: BoardMembersView;
    setRole?: (match: string, role: AccessRole) => Promise<AccessWriteResult>;
  } = {},
) {
  document.body.innerHTML = `
    <small id="note"></small>
    <div id="list"></div>
    <p id="legend" class="hidden"></p>`;
  const toasts: string[] = [];
  let view = opts.view ?? VIEW;
  const setRole = vi.fn(
    opts.setRole ??
      (async (match: string, role: AccessRole) => {
        // The server's answer, so the repaint reads the new level back.
        view = {
          ...view,
          members: view.members.map((m) => (m.email === match ? { ...m, accessRole: role } : m)),
          audience: (view.audience ?? []).map((e) =>
            e.match === match && role !== 'owner' ? { ...e, access: role } : e,
          ),
        };
        return { ok: true };
      }),
  );
  const handle = mountBoardMembers({
    list: document.getElementById('list') as HTMLElement,
    note: document.getElementById('note') as HTMLElement,
    legend: document.getElementById('legend') as HTMLElement,
    read: async () => view,
    remove: async () => true,
    setRole,
    toast: (m) => toasts.push(m),
  });
  return { handle, toasts, setRole, list: document.getElementById('list') as HTMLElement };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const rowOf = (list: HTMLElement, key: string) =>
  list.querySelector<HTMLElement>(`[data-key="${key}"]`) as HTMLElement;
const selectOf = (list: HTMLElement, key: string) =>
  rowOf(list, key).querySelector<HTMLSelectElement>('select') as HTMLSelectElement;
const pick = (sel: HTMLSelectElement, value: string) => {
  sel.value = value;
  sel.dispatchEvent(new Event('change'));
};
const buttonSaying = (row: Element, label: string) =>
  Array.from(row.querySelectorAll('button')).find((b) => b.textContent === label);

describe('a level per person and per domain', () => {
  it('offers the Owner a select on every person and domain row, at the level each holds', async () => {
    const m = mount();
    await m.handle.refresh();
    expect(selectOf(m.list, BOB).value).toBe('view');
    expect(selectOf(m.list, SALT).value).toBe('comment');
    expect(selectOf(m.list, DOMAIN).value).toBe('comment');
    // A domain is not one person, so it is never offered Owner.
    const words = (sel: HTMLSelectElement) => Array.from(sel.options).map((o) => o.textContent);
    expect(words(selectOf(m.list, BOB))).toEqual(['Owner', 'Can edit', 'Can comment', 'Can view']);
    expect(words(selectOf(m.list, DOMAIN))).toEqual(['Can edit', 'Can comment', 'Can view']);
    expect(selectOf(m.list, DOMAIN).getAttribute('aria-label')).toBe(
      `What everyone at ${DOMAIN} can do`,
    );
    expect(document.getElementById('legend')?.textContent).toBe(LEVEL_LEGEND);
    expect(document.getElementById('legend')?.classList.contains('hidden')).toBe(false);
  });

  it('sends the level chosen and says what it did in the list’s words', async () => {
    const m = mount();
    await m.handle.refresh();
    pick(selectOf(m.list, BOB), 'comment');
    await m.handle.settled();
    expect(m.setRole).toHaveBeenCalledWith(BOB, 'comment');
    expect(selectOf(m.list, BOB).value).toBe('comment');
    pick(selectOf(m.list, DOMAIN), 'view');
    await m.handle.settled();
    expect(m.setRole).toHaveBeenLastCalledWith(DOMAIN, 'view');
    expect(m.toasts).toEqual([`${BOB} can now comment`, `Everyone at ${DOMAIN} can now only view`]);
    // Focus stays on the control the reader was using.
    expect(document.activeElement).toBe(selectOf(m.list, DOMAIN));
  });

  it('asks in the row before making somebody an Owner, and Cancel changes nothing', async () => {
    const m = mount();
    await m.handle.refresh();
    pick(selectOf(m.list, BOB), 'owner');
    await tick();
    const asking = rowOf(m.list, BOB);
    expect(asking.textContent).toContain(`Make ${BOB} an Owner?`);
    expect(document.activeElement).toBe(buttonSaying(asking, 'Make Owner'));
    buttonSaying(asking, 'Cancel')?.click();
    await tick();
    expect(m.setRole).not.toHaveBeenCalled();
    expect(selectOf(m.list, BOB).value).toBe('view');

    pick(selectOf(m.list, BOB), 'owner');
    await tick();
    buttonSaying(rowOf(m.list, BOB), 'Make Owner')?.click();
    await m.handle.settled();
    expect(m.setRole).toHaveBeenCalledWith(BOB, 'owner');
    expect(m.toasts).toEqual([`${BOB} is now an Owner`]);
  });

  it('shows the server’s reason when it refuses, and the old level stays', async () => {
    const m = mount({
      setRole: async () => ({
        ok: false,
        message: 'Only the board’s owner, signed in, can do that.',
      }),
    });
    await m.handle.refresh();
    pick(selectOf(m.list, BOB), 'edit');
    await m.handle.settled();
    expect(m.toasts).toEqual(['Only the board’s owner, signed in, can do that.']);
    expect(selectOf(m.list, BOB).value).toBe('view');
  });

  it('gives a member each level as text, at no control', async () => {
    const m = mount({
      view: { ...VIEW, you: { email: BOB, role: 'member', accessRole: 'view' } },
    });
    await m.handle.refresh();
    expect(m.list.querySelectorAll('select')).toHaveLength(0);
    const level = (key: string) =>
      rowOf(m.list, key).querySelector('.board-member-level-text')?.textContent;
    expect(level(BOB)).toBe('Can view');
    expect(level(SALT)).toBe('Can comment');
    expect(level(DOMAIN)).toBe('Can comment');
  });
});
