/**
 * The settings subsection that says who can reach this board, and at what level.
 *
 * Bryan, 2026-09-11, asking for roles: *"Bryan can share a board with someone
 * who can read and comment but cannot act as him, so that a share link stops
 * being a grant of everything he can do"* — and, in the same ask, *"the owner
 * should be able to see in a subsection of the Settings page of the workspace
 * who has access to a workspace and at what level"*. This is that subsection.
 *
 * Two readers, one list. An Owner gets the controls — a role select and a
 * remove — and a Regular User gets the same names and roles with no controls at
 * all. **The missing controls are not the enforcement**: every write here goes
 * to a route that asks the server who you are (`requireOwner`, see
 * `routes/workspace-members.ts`), so a Regular User who rebuilds the request by
 * hand gets a 403 rather than a promotion. Hiding a control a person may not
 * use is courtesy; the refusal is the server's.
 *
 * Its own module, like `review-criteria.ts` next door, for what that buys: the
 * behaviour worth pinning is what the list does when the read fails, what it
 * draws for a member versus an owner, and what a removal does to the row it was
 * clicked on — none of which is reachable from inside `bootBoard`'s wiring.
 */

/** The two levels a board has. Wire values; `roleLabel` is what a person sees. */
export type BoardRole = 'owner' | 'member';

export interface BoardMemberEntry {
  email: string;
  role: BoardRole;
}

/** What `GET /workspaces/<id>/members` answers, narrowed to what is drawn. */
export interface BoardMembersView {
  /** The reader. `email: null` is the operator on their own machine — an owner
   *  with no address, because none was ever proven and none is needed. */
  you: { email: string | null; role: BoardRole };
  members: BoardMemberEntry[];
}

export interface BoardMembersDeps {
  /** The container the rows are drawn into. Emptied on every repaint. */
  list: HTMLElement;
  /** The line under the label: the empty state, or why the list is not there. */
  note: HTMLElement;
  /** Read the list. `null` is a failed read, never an empty board. */
  read: () => Promise<BoardMembersView | null>;
  /** Promote or demote. Resolves false when the server refused. */
  setRole: (email: string, role: BoardRole) => Promise<boolean>;
  /** End one person's access. Resolves false when the server refused. */
  remove: (email: string) => Promise<boolean>;
  /** The board's one-line report. */
  toast: (message: string) => void;
  /**
   * The reader's own level, handed on after every read — `null` when the read
   * failed and nobody knows.
   *
   * THIS LIST IS THE PANEL'S ONE READING OF WHO YOU ARE. The settings panel
   * has other controls that are the Owner's, and a second fetch to learn the
   * same fact is a second answer that can disagree with this one mid-panel.
   * So the subsection that already asks the question says what came back, and
   * the panel decides what the rest of it draws.
   */
  onRole?: (role: BoardRole | null) => void;
}

export interface BoardMembersHandle {
  /** Re-read and repaint. Called every time the panel opens. */
  refresh(): Promise<void>;
  /** Resolves when any in-flight write has finished. Tests await it. */
  settled(): Promise<void>;
}

/** Bryan's words for the two levels, and the only place they are spelled. */
export function roleLabel(role: BoardRole): string {
  return role === 'owner' ? 'Owner' : 'Regular User';
}

export function mountBoardMembers(deps: BoardMembersDeps): BoardMembersHandle {
  const doc = deps.list.ownerDocument;
  let inFlight: Promise<void> | null = null;
  let view: BoardMembersView | null = null;
  /** The row currently asking "are you sure" — one at a time, cleared by any
   *  repaint. Held here rather than in the DOM so a re-read wipes it. */
  let confirming: string | null = null;

  /**
   * Repaint on a LATER TURN, never inside the click that asked for it.
   *
   * `paint` replaces every row, so painting from a click handler detaches the
   * button the event is still travelling up from. The settings panel closes
   * itself when a click lands outside it, and it reads "outside" off the tree
   * as it is by the time the event reaches `document` — so a synchronous
   * repaint here closed the whole panel on the tap that opened this
   * confirmation. A turn later the event is over and the tree it read is the
   * one the person is looking at.
   *
   * The writes below need no such care: they repaint after awaiting the
   * server, which is already several turns away.
   */
  function repaintSoon(): void {
    setTimeout(paint, 0);
  }

  function clear(): void {
    while (deps.list.firstChild) deps.list.removeChild(deps.list.firstChild);
  }

  function button(label: string, extra: string): HTMLButtonElement {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = `board-btn ${extra}`;
    b.textContent = label;
    return b;
  }

  function roleSelect(entry: BoardMemberEntry): HTMLSelectElement {
    const sel = doc.createElement('select');
    sel.className = 'board-select board-member-role';
    sel.setAttribute('aria-label', `Role for ${entry.email}`);
    for (const role of ['owner', 'member'] as const) {
      const opt = doc.createElement('option');
      opt.value = role;
      opt.textContent = roleLabel(role);
      if (role === entry.role) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      const next = sel.value === 'owner' ? 'owner' : 'member';
      run(async () => {
        const ok = await deps.setRole(entry.email, next);
        if (!ok) {
          deps.toast('Could not change that role');
          // Re-read rather than putting the old value back by hand: the server
          // is what decides what the role now is, and a refusal we guessed at
          // would leave the box saying something nobody wrote.
          await refresh();
          return;
        }
        await refresh();
        deps.toast(`${entry.email} is now ${roleLabel(next)}`);
      });
    });
    return sel;
  }

  /** The confirmation, in the row rather than in a dialog — the same shape the
   *  goal panel uses for an archive. It names who is about to lose access,
   *  because a confirmation that cannot say what it is about to do is a dialog
   *  pretending to be one. */
  function confirmRow(entry: BoardMemberEntry): HTMLElement {
    const row = doc.createElement('div');
    row.className = 'board-member board-member--confirm';
    const ask = doc.createElement('span');
    ask.className = 'board-member-who';
    ask.textContent = `Remove ${entry.email}?`;
    row.appendChild(ask);
    const go = button('Remove', 'board-member-remove');
    go.addEventListener('click', () => {
      run(async () => {
        const ok = await deps.remove(entry.email);
        confirming = null;
        if (!ok) {
          deps.toast('Could not remove that person');
          await refresh();
          return;
        }
        await refresh();
        deps.toast(`${entry.email} no longer has access`);
      });
    });
    const cancel = button('Cancel', 'board-member-cancel');
    cancel.addEventListener('click', () => {
      confirming = null;
      repaintSoon();
    });
    row.appendChild(go);
    row.appendChild(cancel);
    return row;
  }

  function memberRow(entry: BoardMemberEntry, canEdit: boolean, isYou: boolean): HTMLElement {
    if (confirming === entry.email) return confirmRow(entry);
    const row = doc.createElement('div');
    row.className = 'board-member';
    const who = doc.createElement('span');
    who.className = 'board-member-who';
    who.textContent = isYou ? `${entry.email} (you)` : entry.email;
    row.appendChild(who);
    // Your own row carries no controls even when you are the owner. Demoting
    // or removing yourself from the list you are reading is a slip far more
    // often than an intention, and the tools can still do it deliberately.
    if (!canEdit || isYou) {
      const role = doc.createElement('span');
      role.className = 'board-member-role-text';
      role.textContent = roleLabel(entry.role);
      row.appendChild(role);
      return row;
    }
    row.appendChild(roleSelect(entry));
    const remove = button('Remove', 'board-member-remove');
    remove.addEventListener('click', () => {
      confirming = entry.email;
      repaintSoon();
    });
    row.appendChild(remove);
    return row;
  }

  function paint(): void {
    clear();
    if (!view) {
      deps.note.textContent = 'Could not read who has access — reopen this panel to try again.';
      return;
    }
    const canEdit = view.you.role === 'owner';
    const yours = view.you.email;
    // The operator holds no membership record — a board is owned by whoever
    // holds the machine it was made on — so their own seat is drawn from `you`
    // rather than found in the list. Without this an owner opens the panel and
    // sees a board with no owner in it.
    if (yours === null) {
      const row = doc.createElement('div');
      row.className = 'board-member';
      const who = doc.createElement('span');
      who.className = 'board-member-who';
      who.textContent = 'You';
      const role = doc.createElement('span');
      role.className = 'board-member-role-text';
      role.textContent = roleLabel(view.you.role);
      row.appendChild(who);
      row.appendChild(role);
      deps.list.appendChild(row);
    }
    for (const entry of view.members) {
      deps.list.appendChild(memberRow(entry, canEdit, entry.email === yours));
    }
    // The empty state and nothing else. A line saying what the controls do
    // explains something already on the screen, and a line saying an Owner is
    // needed explains something deliberately absent (Bryan: no explanatory
    // text — the affordance is the message).
    deps.note.textContent =
      view.members.length === 0 ? 'Nobody else has been given access yet.' : '';
  }

  async function refresh(): Promise<void> {
    view = await deps.read();
    confirming = null;
    // Before the paint, so the panel's other controls settle on the same turn
    // this list does rather than one behind it.
    deps.onRole?.(view ? view.you.role : null);
    paint();
  }

  function run(work: () => Promise<void>): void {
    inFlight = work().finally(() => {
      inFlight = null;
    });
  }

  return {
    refresh,
    settled: async () => {
      await inFlight;
    },
  };
}
