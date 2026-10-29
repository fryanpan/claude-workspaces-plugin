/**
 * The Settings subsection that says who can sign in to this board.
 *
 * What is pinned here is how the list files each person under the entry that
 * let them in, what a member (not the owner) is handed, what a removal asks
 * before it happens, and what the Add form says when the server refuses or
 * files a proposal instead (Bryan, 29 Oct: only he changes who is in).
 *
 * The missing controls are courtesy, never the enforcement: the routes behind
 * them are asserted over HTTP in `packages/server/test/share-access-door.test.ts`.
 *
 * All fixtures are synthetic.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type AccessWriteResult,
  type BoardMembersView,
  accessLinkLabel,
  accessWriteOf,
  mountBoardMembers,
  readAccessMatch,
  roleLabel,
} from '../src/board/board-members.ts';

const KEEPER = 'keeper@harborlight.example';
const PILOT = 'pilot@saltmarsh.example';
const INVITED = 'bob@riverbend.example';
const DAY = Date.UTC(2026, 9, 9, 12);

function dom() {
  document.body.innerHTML = `
    <div class="board-settings-row board-settings-row--members">
      <span class="board-settings-label">Who has access
        <small id="board-members-note" class="board-settings-note"></small>
      </span>
      <div id="board-members-list" class="board-members"></div>
      <form id="add" class="acc-add"><input name="match" /><button type="submit">Add</button></form>
      <p id="err"></p>
      <a href="/access"><span id="link"></span></a>
    </div>`;
  return {
    list: document.getElementById('board-members-list') as HTMLElement,
    note: document.getElementById('board-members-note') as HTMLElement,
    form: document.getElementById('add') as HTMLFormElement,
    error: document.getElementById('err') as HTMLElement,
    linkLabel: document.getElementById('link') as HTMLElement,
  };
}

const VIEW: BoardMembersView = {
  you: { email: null, role: 'owner' },
  audience: [
    { match: KEEPER, addedAt: DAY },
    { match: INVITED, addedAt: DAY },
    { match: '@saltmarsh.example', addedAt: DAY },
  ],
  members: [
    { email: KEEPER, role: 'member', addedAt: DAY, entry: KEEPER, link: 'Launch review' },
    { email: PILOT, role: 'owner', addedAt: DAY, entry: '@saltmarsh.example' },
  ],
  openProposals: 0,
};

function mount(
  opts: {
    read?: () => Promise<BoardMembersView | null>;
    remove?: (match: string) => Promise<boolean>;
    add?: (match: string) => Promise<AccessWriteResult>;
  } = {},
) {
  const els = dom();
  const toasts: string[] = [];
  const remove = opts.remove ?? vi.fn(async () => true);
  const add = opts.add ?? vi.fn(async () => ({ ok: true }));
  const handle = mountBoardMembers({
    ...els,
    read: opts.read ?? (async () => VIEW),
    remove,
    add,
    accessHref: (n) => (n > 0 ? '/access/waiting' : '/access'),
    toast: (m) => toasts.push(m),
  });
  return { ...els, handle, toasts, remove, add };
}

const rows = (list: HTMLElement) => Array.from(list.querySelectorAll('.board-member'));
const text = (row: Element) => row.querySelector('.board-member-who')?.textContent ?? '';
const buttonSaying = (row: Element, label: string) =>
  Array.from(row.querySelectorAll('button')).find((b) => b.textContent === label);
const rowFor = (list: HTMLElement, who: string) =>
  rows(list).find((r) => text(r) === who) as HTMLElement;

/** One turn: Remove and Cancel repaint on a later turn on purpose. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const submit = async (m: ReturnType<typeof mount>, value: string) => {
  (m.form.elements.namedItem('match') as HTMLInputElement).value = value;
  m.form.dispatchEvent(new Event('submit', { cancelable: true }));
  await m.handle.settled();
};

describe('who has access', () => {
  it('lists exact addresses, then each domain with its people under it', async () => {
    const m = mount();
    await m.handle.refresh();
    expect(rows(m.list).map(text)).toEqual([
      'You',
      KEEPER,
      INVITED,
      'Everyone at @saltmarsh.example',
      PILOT,
    ]);
    expect(rowFor(m.list, KEEPER).textContent).toContain(
      'Signed in 9 Oct via link “Launch review”',
    );
    expect(rowFor(m.list, INVITED).textContent).toContain('Added 9 Oct · not signed in yet');
    expect(rowFor(m.list, 'Everyone at @saltmarsh.example').textContent).toContain(
      '1 person signed in',
    );
    expect(rowFor(m.list, PILOT).classList.contains('acc-under')).toBe(true);
    // An invited Owner still reads as one.
    expect(rowFor(m.list, PILOT).textContent).toContain(roleLabel('owner'));
    expect(m.note.textContent).toBe('Who can sign in to this board.');
  });

  it('gives a member the list with no controls and no Add form', async () => {
    const m = mount({ read: async () => ({ ...VIEW, you: { email: KEEPER, role: 'member' } }) });
    await m.handle.refresh();
    expect(m.list.querySelectorAll('button')).toHaveLength(0);
    expect(m.form.classList.contains('hidden')).toBe(true);
    expect(rows(m.list).map(text)).toContain(`${KEEPER} (you)`);
  });

  it('asks before a domain goes, naming how many people go with it, and cancelling removes nobody', async () => {
    const m = mount();
    await m.handle.refresh();
    buttonSaying(rowFor(m.list, 'Everyone at @saltmarsh.example'), 'Remove')?.click();
    await tick();
    const asking = rows(m.list).find((r) => text(r).startsWith('Stop letting in'));
    expect(text(asking as Element)).toBe(
      'Stop letting in everyone at @saltmarsh.example? 1 signed-in person loses access.',
    );
    buttonSaying(asking as Element, 'Cancel')?.click();
    await tick();
    expect(m.remove).not.toHaveBeenCalled();
  });

  it('removes one person a domain let in, and says the domain will not let them back', async () => {
    const m = mount();
    await m.handle.refresh();
    buttonSaying(rowFor(m.list, PILOT), 'Remove')?.click();
    await tick();
    const asking = rows(m.list).find((r) => text(r).startsWith(`Remove ${PILOT}?`)) as Element;
    expect(text(asking)).toContain('@saltmarsh.example will not let them back in.');
    buttonSaying(asking, 'Remove')?.click();
    await m.handle.settled();
    expect(m.remove).toHaveBeenCalledWith(PILOT);
    expect(m.toasts).toEqual([`${PILOT} no longer has access`]);
  });

  it('says so when a removal is refused, and redraws what the server says', async () => {
    const reads = [VIEW, { ...VIEW, audience: [], members: [] }];
    let n = 0;
    const m = mount({
      read: async () => reads[Math.min(n++, 1)] as BoardMembersView,
      remove: async () => false,
    });
    await m.handle.refresh();
    buttonSaying(rowFor(m.list, INVITED), 'Remove')?.click();
    await tick();
    buttonSaying(
      rows(m.list).find((r) => text(r).startsWith(`Remove ${INVITED}?`)) as Element,
      'Remove',
    )?.click();
    await m.handle.settled();
    expect(m.toasts).toEqual(['Could not remove that']);
    expect(rows(m.list).map(text)).toEqual(['You']);
  });

  it('refuses a typo and a duplicate before asking the server, saying what to fix', async () => {
    const m = mount();
    await m.handle.refresh();
    const input = m.form.elements.namedItem('match') as HTMLInputElement;
    await submit(m, 'not an address');
    expect(m.error.textContent).toBe('Take out the spaces: one address or one domain at a time.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await submit(m, 'harborlight');
    expect(m.error.textContent).toContain('Add an @');
    await submit(m, 'ops@harborlight');
    expect(m.error.textContent).toBe('Add the ending after harborlight, like @harborlight.com.');
    await submit(m, '');
    expect(m.error.textContent).toContain('Type an address');
    // Typing again clears the message, so it never describes what is no longer there.
    input.dispatchEvent(new Event('input'));
    expect(m.error.textContent).toBe('');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    await submit(m, KEEPER.toUpperCase());
    expect(m.error.textContent).toBe(`${KEEPER} is already on this board.`);
    expect(m.add).not.toHaveBeenCalled();
  });

  it('asks again before letting a whole domain in', async () => {
    const m = mount();
    await m.handle.refresh();
    await submit(m, '@riverbend.example');
    expect(m.add).not.toHaveBeenCalled();
    expect(m.error.textContent).toBe(
      'This lets anyone with an @riverbend.example address sign in. Press Add again to confirm.',
    );
    await submit(m, '@riverbend.example');
    expect(m.add).toHaveBeenCalledWith('@riverbend.example');
  });

  it('keeps focus on the row a removal was asked from, and on its neighbour once it goes', async () => {
    let gone = false;
    const m = mount({
      read: async () =>
        gone ? { ...VIEW, audience: VIEW.audience?.filter((e) => e.match !== INVITED) } : VIEW,
      remove: async () => {
        gone = true;
        return true;
      },
    });
    await m.handle.refresh();
    buttonSaying(rowFor(m.list, INVITED), 'Remove')?.click();
    await tick();
    const asking = () => rows(m.list).find((r) => text(r).startsWith(`Remove ${INVITED}?`));
    expect(document.activeElement?.textContent).toBe('Cancel');
    expect(asking()?.contains(document.activeElement)).toBe(true);
    (document.activeElement as HTMLElement).click();
    await tick();
    expect(document.activeElement).toBe(buttonSaying(rowFor(m.list, INVITED), 'Remove'));
    buttonSaying(rowFor(m.list, INVITED), 'Remove')?.click();
    await tick();
    buttonSaying(asking() as Element, 'Remove')?.click();
    await m.handle.settled();
    // The next row down is the domain's.
    expect(document.activeElement).toBe(
      buttonSaying(rowFor(m.list, 'Everyone at @saltmarsh.example'), 'Remove'),
    );
  });

  it('says when an add was filed for approval rather than applied, and shows a refusal', async () => {
    const results: AccessWriteResult[] = [
      { ok: true, proposed: true },
      { ok: false, message: 'this board is locked against sharing' },
    ];
    let n = 0;
    const m = mount({ add: async () => results[n++] as AccessWriteResult });
    await m.handle.refresh();
    await submit(m, '@riverbend.example');
    await submit(m, '@riverbend.example');
    expect(m.toasts).toEqual(['Filed @riverbend.example for the owner’s approval']);
    await submit(m, 'ops@riverbend.example');
    expect(m.error.textContent).toBe('this board is locked against sharing');
  });

  it('points the link at what is waiting for this board', async () => {
    const m = mount({ read: async () => ({ ...VIEW, openProposals: 2 }) });
    await m.handle.refresh();
    expect(m.linkLabel.textContent).toBe('2 changes an agent proposed for this board');
    expect(m.linkLabel.closest('a')?.getAttribute('href')).toBe('/access/waiting');
    expect(accessLinkLabel(0)).toBe('Everyone with access, on every board');
  });

  it('puts the waiting changes in a row at the top, shown only while there are some', async () => {
    let waiting = 1;
    const els = dom();
    const top = document.createElement('a');
    top.className = 'hidden';
    const label = document.createElement('span');
    top.appendChild(label);
    els.list.before(top);
    const handle = mountBoardMembers({
      ...els,
      waiting: label,
      read: async () => ({ ...VIEW, openProposals: waiting }),
      remove: async () => true,
      accessHref: (n) => (n > 0 ? '/access/waiting' : '/access'),
      toast: () => {},
    });
    await handle.refresh();
    expect(top.classList.contains('hidden')).toBe(false);
    expect(label.textContent).toBe('1 change an agent proposed for this board');
    expect(top.getAttribute('href')).toBe('/access/waiting');
    // The link at the bottom names the page itself.
    expect(els.linkLabel.textContent).toBe('Everyone with access, on every board');
    waiting = 0;
    await handle.changed();
    expect(top.classList.contains('hidden')).toBe(true);
  });

  it('says the read failed rather than drawing an empty board', async () => {
    const m = mount({ read: async () => null });
    await m.handle.refresh();
    expect(rows(m.list)).toHaveLength(0);
    expect(m.note.textContent).toContain('Could not read');
  });

  it('says plainly when nobody has been given access yet', async () => {
    const m = mount({ read: async () => ({ you: { email: null, role: 'owner' }, members: [] }) });
    await m.handle.refresh();
    expect(m.note.textContent).toContain('Nobody else has been given access yet.');
  });
});

describe('the pieces the form reads', () => {
  it('takes an address or an @domain, lower-cased, and nothing else', () => {
    expect(readAccessMatch(' Ops@Riverbend.Example ')).toBe('ops@riverbend.example');
    expect(readAccessMatch('@saltmarsh.example')).toBe('@saltmarsh.example');
    expect(readAccessMatch('saltmarsh')).toBeNull();
    expect(readAccessMatch('@localhost')).toBeNull();
  });

  it('reads a 202 as filed, and turns the agent-worded refusal into the person’s', () => {
    expect(accessWriteOf({ ok: true, status: 202, data: {} })).toEqual({
      ok: true,
      proposed: true,
    });
    expect(accessWriteOf({ ok: true, status: 200, data: {} })).toEqual({ ok: true });
    expect(
      accessWriteOf({ ok: false, status: 400, data: { error: 'task-required' } }).message,
    ).toBe('Only the board’s owner, signed in, can let someone new in.');
  });
});
