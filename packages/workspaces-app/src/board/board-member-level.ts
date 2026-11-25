/**
 * What each person on a board may do, and the control the owner changes it
 * with in "Who has access".
 *
 * Four levels, the server's own words (`share/board-access.ts`): an Owner
 * changes everything; edit changes tasks, docs and the settings agents read;
 * comment comments and replies; view reads. A `@domain` row carries one level
 * for everyone it lets in, and never Owner: a domain is not one person.
 *
 * The control keeps one width whatever it says (CLAUDE.md, "A UI element
 * keeps its size and position"), and the same width as the text a member
 * reads in its place, so the Remove beside it never moves.
 */

/** The server's four words. Absent on a row from an older server. */
export type AccessRole = 'owner' | 'edit' | 'comment' | 'view';

const LEVELS: ReadonlyArray<readonly [AccessRole, string]> = [
  ['owner', 'Owner'],
  ['edit', 'Can edit'],
  ['comment', 'Can comment'],
  ['view', 'Can view'],
];

const RANK: Record<AccessRole, number> = { view: 0, comment: 1, edit: 2, owner: 3 };

/** The one line under the list that says what the three lesser levels mean. */
export const LEVEL_LEGEND =
  'Can edit: change tasks, docs and settings agents read. Can comment: comment and reply only. Can view: read only.';

export function levelLabel(role: AccessRole): string {
  return LEVELS.find(([r]) => r === role)?.[1] ?? 'Can edit';
}

/** "Bob can now only view", or "can now edit" when it lets them do more. */
export function levelToast(who: string, before: AccessRole, after: AccessRole): string {
  if (after === 'owner') return `${who} is now an Owner`;
  const verb = after === 'edit' ? 'edit' : after;
  return RANK[after] < RANK[before] ? `${who} can now only ${verb}` : `${who} can now ${verb}`;
}

/** What the confirmation says before somebody is made an Owner. */
export function ownerAsk(email: string): string {
  return `Make ${email} an Owner? They can change everything on this board except who is in it.`;
}

/**
 * The select. `onPick` gets the level chosen; the select itself snaps back to
 * `current`, because the list repaints from what the server then says.
 */
export function levelSelect(
  doc: Document,
  opts: {
    current: AccessRole;
    aria: string;
    domain: boolean;
    onPick: (next: AccessRole) => void;
  },
): HTMLSelectElement {
  const sel = doc.createElement('select');
  sel.className = 'board-select board-member-level';
  sel.setAttribute('aria-label', opts.aria);
  for (const [value, text] of LEVELS) {
    if (value === 'owner' && opts.domain) continue;
    const o = doc.createElement('option');
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  }
  sel.value = opts.current;
  sel.addEventListener('change', () => {
    const next = sel.value as AccessRole;
    sel.value = opts.current;
    if (next !== opts.current) opts.onPick(next);
  });
  return sel;
}

/** A member's view of a level: the same words, as text, at the same width. */
export function levelText(doc: Document, role: AccessRole): HTMLElement {
  const span = doc.createElement('span');
  span.className = 'board-member-level-text';
  span.textContent = levelLabel(role);
  return span;
}
