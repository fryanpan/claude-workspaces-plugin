/**
 * The Settings subsection that says who has access, and at what level.
 *
 * What is pinned here is what the list does when the reader is NOT the owner,
 * when the read fails, and when a write is refused — the three states a happy
 * path never reaches and the first of which is the whole feature (Bryan,
 * 2026-09-11: *"someone who can read and comment but cannot act as him"*).
 *
 * The missing controls are courtesy, never the enforcement: the routes behind
 * them refuse a Regular User server-side, which is asserted over HTTP in
 * `packages/server/test/board-roles.test.ts`. What a test here can show is that
 * a member is not handed a control that would only ever 403.
 *
 * All fixtures are synthetic.
 */

import { describe, expect, it, vi } from 'vitest';
import { type BoardMembersView, mountBoardMembers, roleLabel } from '../src/board/board-members.ts';

const KEEPER = 'keeper@harborlight.example';
const PILOT = 'pilot@saltmarsh.example';

function dom() {
  document.body.innerHTML = `
    <div class="board-settings-row board-settings-row--members">
      <span class="board-settings-label">Who has access
        <small id="board-members-note" class="board-settings-note"></small>
      </span>
      <div id="board-members-list" class="board-members"></div>
    </div>`;
  return {
    list: document.getElementById('board-members-list') as HTMLElement,
    note: document.getElementById('board-members-note') as HTMLElement,
  };
}

const VIEW: BoardMembersView = {
  you: { email: null, role: 'owner' },
  members: [
    { email: KEEPER, role: 'member' },
    { email: PILOT, role: 'owner' },
  ],
};

function mount(
  opts: {
    read?: () => Promise<BoardMembersView | null>;
    setRole?: (email: string, role: 'owner' | 'member') => Promise<boolean>;
    remove?: (email: string) => Promise<boolean>;
  } = {},
) {
  const els = dom();
  const toasts: string[] = [];
  const setRole = opts.setRole ?? vi.fn(async () => true);
  const remove = opts.remove ?? vi.fn(async () => true);
  const handle = mountBoardMembers({
    ...els,
    read: opts.read ?? (async () => VIEW),
    setRole,
    remove,
    toast: (m) => toasts.push(m),
  });
  return { ...els, handle, toasts, setRole, remove };
}

const rows = (list: HTMLElement) => Array.from(list.querySelectorAll('.board-member'));
const text = (row: Element) => row.querySelector('.board-member-who')?.textContent ?? '';
const buttonSaying = (row: Element, label: string) =>
  Array.from(row.querySelectorAll('button')).find((b) => b.textContent === label);

/**
 * One turn of the event loop. The Remove and Cancel presses repaint on a later
 * turn on purpose — painting inside the click detaches the button the event is
 * still travelling from, which closed the whole settings panel
 * (`board-settings-members-panel.test.ts`).
 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('who has access', () => {
  it('names each person and the level in Bryan’s words', async () => {
    const m = mount();
    await m.handle.refresh();
    // The operator holds no membership record — a board belongs to whoever
    // holds the machine — so their seat is drawn from `you` or it is nowhere.
    expect(rows(m.list).map(text)).toEqual(['You', KEEPER, PILOT]);
    expect(roleLabel('owner')).toBe('Owner');
    expect(roleLabel('member')).toBe('Regular User');
  });

  it('gives a Regular User the list with no controls at all', async () => {
    const m = mount({
      read: async () => ({ you: { email: KEEPER, role: 'member' }, members: VIEW.members }),
    });
    await m.handle.refresh();
    expect(m.list.querySelectorAll('select')).toHaveLength(0);
    expect(m.list.querySelectorAll('button')).toHaveLength(0);
    // They still read who is here and at what level — everything in a
    // workspace is available to everyone in it.
    expect(m.list.textContent).toContain('Owner');
    expect(m.list.textContent).toContain('Regular User');
    expect(rows(m.list).map(text)).toEqual([`${KEEPER} (you)`, PILOT]);
  });

  it('draws no controls on your own row, so the panel cannot lock you out', async () => {
    const m = mount({
      read: async () => ({ you: { email: PILOT, role: 'owner' }, members: VIEW.members }),
    });
    await m.handle.refresh();
    const mine = rows(m.list).find((r) => text(r).startsWith(PILOT));
    expect(mine?.querySelectorAll('select')).toHaveLength(0);
    expect(mine?.querySelectorAll('button')).toHaveLength(0);
    // Somebody else's row keeps both.
    const theirs = rows(m.list).find((r) => text(r) === KEEPER);
    expect(theirs?.querySelectorAll('select')).toHaveLength(1);
  });

  it('promotes through the select and says who is now what', async () => {
    const m = mount();
    await m.handle.refresh();
    const row = rows(m.list).find((r) => text(r) === KEEPER) as HTMLElement;
    const select = row.querySelector('select') as HTMLSelectElement;
    select.value = 'owner';
    select.dispatchEvent(new Event('change'));
    await m.handle.settled();
    expect(m.setRole).toHaveBeenCalledWith(KEEPER, 'owner');
    expect(m.toasts).toEqual([`${KEEPER} is now Owner`]);
  });

  it('asks before it ends somebody’s access, and cancelling removes nobody', async () => {
    const m = mount();
    await m.handle.refresh();
    const row = rows(m.list).find((r) => text(r) === KEEPER) as HTMLElement;
    (buttonSaying(row, 'Remove') as HTMLButtonElement).click();
    await tick();
    // The confirmation names who, in the row it is about.
    const asking = rows(m.list).find((r) => text(r) === `Remove ${KEEPER}?`);
    expect(asking).toBeTruthy();
    (buttonSaying(asking as Element, 'Cancel') as HTMLButtonElement).click();
    await tick();
    expect(m.remove).not.toHaveBeenCalled();
    expect(rows(m.list).map(text)).toEqual(['You', KEEPER, PILOT]);
  });

  it('removes on the second press', async () => {
    const m = mount();
    await m.handle.refresh();
    const row = rows(m.list).find((r) => text(r) === KEEPER) as HTMLElement;
    (buttonSaying(row, 'Remove') as HTMLButtonElement).click();
    await tick();
    const asking = rows(m.list).find((r) => text(r) === `Remove ${KEEPER}?`) as Element;
    (buttonSaying(asking, 'Remove') as HTMLButtonElement).click();
    await m.handle.settled();
    expect(m.remove).toHaveBeenCalledWith(KEEPER);
    expect(m.toasts).toEqual([`${KEEPER} no longer has access`]);
  });

  it('says so when a write is refused, and re-reads rather than guessing', async () => {
    const reads: BoardMembersView[] = [
      VIEW,
      { you: VIEW.you, members: [{ email: KEEPER, role: 'member' }] },
    ];
    let n = 0;
    const m = mount({
      read: async () => reads[Math.min(n++, reads.length - 1)] as BoardMembersView,
      setRole: async () => false,
    });
    await m.handle.refresh();
    const row = rows(m.list).find((r) => text(r) === KEEPER) as HTMLElement;
    const select = row.querySelector('select') as HTMLSelectElement;
    select.value = 'owner';
    select.dispatchEvent(new Event('change'));
    await m.handle.settled();
    expect(m.toasts).toEqual(['Could not change that role']);
    // The list is the server's answer after the refusal, not the box the
    // reader left behind: a refused write that repainted from the select
    // would show a promotion that never happened.
    expect(rows(m.list).map(text)).toEqual(['You', KEEPER]);
  });

  it('says the read failed rather than drawing an empty board', async () => {
    const m = mount({ read: async () => null });
    await m.handle.refresh();
    expect(rows(m.list)).toHaveLength(0);
    expect(m.note.textContent).toContain('Could not read');
    // An empty list and a failed read must not look alike: one of them means
    // nobody else can reach this board, and a reader acts on that.
    expect(m.note.textContent).not.toContain('Nobody else');
  });

  it('says plainly when nobody has been given access yet', async () => {
    const m = mount({ read: async () => ({ you: { email: null, role: 'owner' }, members: [] }) });
    await m.handle.refresh();
    expect(m.note.textContent).toContain('Nobody else has been given access yet.');
  });
});
