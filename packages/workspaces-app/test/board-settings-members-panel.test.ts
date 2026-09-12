/**
 * Tapping a control inside the settings panel must not close the panel.
 *
 * The members subsection is the first control in this panel that repaints its
 * own section from a click handler, and that turned out to close the whole
 * panel: the document-level "clicked outside" listener runs after the row's
 * handler, by which time the button it fired on has been replaced, so a click
 * that began inside the panel read as a click outside it. A person tapping
 * Remove saw the settings vanish instead of a confirmation.
 *
 * So this drives the REAL wiring — `buildShell` for the markup and
 * `wireBoardSettingsPanel` for the listeners — rather than the module alone,
 * because the bug lived in the seam between them and neither half shows it.
 * `board-members.test.ts` next door covers what the list draws.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { wireBoardSettingsPanel } from '../src/board/board-settings-panel.ts';
import { buildShell } from '../src/board/board-shell.ts';

const KEEPER = 'keeper@harborlight.example';
const WS = 'w-hbl';
const CRITERIA = 'Every headline is a question, and every option names its cost.';
const CAP = 3;

afterEach(() => {
  document.body.innerHTML = '';
});

/** The settings read the panel's two board-wide editors are drawn from. */
const SETTINGS = {
  reviewItemCriteria: { value: CRITERIA, isDefault: false },
  parallelismCap: { value: CAP, isDefault: false },
  dispatchesInUse: 1,
};

interface Panel {
  isOpen: () => boolean;
  open: () => void;
  /** Open, and settle every read the open kicked off. */
  opened: () => Promise<void>;
  sent: Array<{ path: string; method: string }>;
}

/**
 * The real shell and the real wiring, as a reader of the given level.
 *
 * `you.email` is null for the owner — the operator holds no membership record
 * — and the Regular User is one of the two people in the list, which is what a
 * guest's own read answers.
 */
function panel(role: 'owner' | 'member' = 'owner'): Panel {
  const root = document.createElement('div');
  root.id = 'board-root';
  document.body.appendChild(root);
  buildShell(document, root, 'Harborlight relay', WS);
  const el = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`missing #${id}`);
    return found;
  };
  let open = false;
  const sent: Array<{ path: string; method: string }> = [];
  wireBoardSettingsPanel({
    document,
    el,
    workspaceId: WS,
    author: { id: 'u-reader', name: 'Reader' },
    user: { id: 'u-reader', name: 'Reader' },
    fetchJson: async <T>(path: string): Promise<T | null> => {
      if (path.endsWith('/members')) {
        return {
          you: role === 'owner' ? { email: null, role } : { email: KEEPER, role },
          members: [{ email: KEEPER, role: 'member' }],
        } as unknown as T;
      }
      if (path.endsWith('/settings')) return SETTINGS as unknown as T;
      return null;
    },
    send: async (path, method) => {
      sent.push({ path, method });
      return { ok: true };
    },
    showToast: () => {},
    isOpen: () => open,
    setOpen: (next) => {
      open = next;
    },
    onOpen: () => {},
    renderSettingsPanel: () => {
      el('board-settings-panel').classList.toggle('hidden', !open);
    },
    href: () => `/workspaces/${WS}`,
  });
  const click = () =>
    el('board-settings').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return {
    isOpen: () => open,
    open: click,
    opened: async () => {
      click();
      // Poll rather than count microtasks: the open chains a members read and
      // then two settings reads, and a fixed number of ticks is a number that
      // changes whenever one of them grows an await.
      for (let i = 0; i < 50 && el('board-review-criteria-text').textContent === ''; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    sent,
  };
}

/** Is this element up, by the class the panel toggles? */
const shown = (id: string): boolean =>
  document.getElementById(id)?.classList.contains('hidden') === false;

describe('the settings panel and its members subsection', () => {
  it('stays open when Remove is tapped, and shows the confirmation', async () => {
    const p = panel();
    await p.opened();
    const remove = document.querySelector<HTMLButtonElement>(
      '#board-members-list .board-member-remove',
    );
    expect(remove).not.toBeNull();
    remove?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Settings is still open, and the row repainted under the tap.
    expect(p.isOpen()).toBe(true);
    expect(document.getElementById('board-settings-panel')?.classList.contains('hidden')).toBe(
      false,
    );
    // And the tap did what it is for: the row now asks, naming the person.
    const confirm = document.querySelector('#board-members-list .board-member--confirm');
    expect(confirm?.textContent).toContain(`Remove ${KEEPER}?`);
  });

  it('a click anywhere else on the page leaves settings open', async () => {
    // The popover this replaced closed on any click outside itself, which is
    // what made the Remove tap above a bug worth a test: a control repainting
    // its own section had detached the button by the time that listener read
    // the tree. A page closes by the way out it draws, so neither case can
    // come back.
    const p = panel();
    p.open();
    await Promise.resolve();
    expect(p.isOpen()).toBe(true);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(p.isOpen()).toBe(true);
  });

  it('draws "Who has access" above the two editors a long panel buries', async () => {
    // Position, not pixels: jsdom lays nothing out. What a test here can hold
    // is the ORDER inside the panel, which is what put the subsection past the
    // fold at 1180x820 — the measured height is in the PR body.
    panel();
    const rows = Array.from(
      document.querySelectorAll('#board-settings-panel .board-settings-row'),
    ).map((r) => r.className);
    const members = rows.findIndex((c) => c.includes('--members'));
    const criteria = rows.findIndex((c) => c.includes('--criteria'));
    const cap = rows.findIndex((c) => c.includes('--cap'));
    expect(members).toBeGreaterThanOrEqual(0);
    expect(members).toBeLessThan(criteria);
    expect(members).toBeLessThan(cap);
  });
});

/**
 * A Regular User's Settings panel shows only what their level lets them change.
 *
 * Found by the fresh-eyes pass over the roles work: the panel drew two Save
 * buttons, two editable fields and a link to a page the server will not serve
 * a guest. The server now refuses the write (`requireOwner` on
 * `PUT /workspaces/<id>/settings`) and this is the panel telling the truth
 * about it. The level comes from the one members read the panel already does,
 * which is why these cases drive the whole wiring rather than either editor
 * alone.
 */
describe('the settings panel at each level', () => {
  it('gives a Regular User the board-wide settings as plain text, with nothing to press', async () => {
    const p = panel('member');
    await p.opened();
    // The criteria and the cap are readable — everything in a workspace is
    // available to everyone in it — and they are readable as TEXT.
    expect(document.getElementById('board-review-criteria-text')?.textContent).toBe(CRITERIA);
    expect(document.getElementById('board-parallelism-cap-text')?.textContent).toBe(String(CAP));
    expect(shown('board-review-criteria-text')).toBe(true);
    expect(shown('board-parallelism-cap-text')).toBe(true);
    // No editor and no Save, on either row.
    expect(shown('board-review-criteria')).toBe(false);
    expect(shown('board-review-criteria-actions')).toBe(false);
    expect(shown('board-parallelism-cap')).toBe(false);
    expect(shown('board-parallelism-cap-actions')).toBe(false);
    // And no way through to the prompts page, which is trusted-local: a link
    // that leads to a refusal is the same broken promise as a dead Save.
    expect(shown('board-prompts-link')).toBe(false);
    // No caption took the controls' place (Bryan: the affordance is the
    // message) — the note under each label is empty rather than explaining.
    expect(document.getElementById('board-review-criteria-note')?.textContent).toBe('');
    expect(document.getElementById('board-parallelism-cap-note')?.textContent).toBe('');
    // The members list is theirs to read, and holds no controls.
    expect(document.querySelector('#board-members-list .board-member-role-text')).not.toBeNull();
    expect(document.querySelector('#board-members-list .board-member-remove')).toBeNull();
    // The per-viewer rows are everyone's: this device's notifications and
    // which done tasks this reader sees are not the board's business.
    expect(shown('board-push-toggle')).toBe(true);
    expect(shown('board-done-filter')).toBe(true);
    // Nothing was written on the way in.
    expect(p.sent).toEqual([]);
  });

  it('offers nothing owner-only while the level is still in flight', async () => {
    // The shell's own markup draws both editors, both Save pairs and the
    // Prompts link. The level arrives over the network, so between the gear
    // press and that answer there is a window — short here, long on a phone
    // — in which the panel is on screen and the reader's level is unknown.
    // It fails CLOSED: the controls are put away at mount and stay away
    // across the press, so nothing owner-only is ever pressable by somebody
    // who turns out to be a Regular User.
    const p = panel('member');
    for (const id of [
      'board-review-criteria',
      'board-review-criteria-actions',
      'board-parallelism-cap',
      'board-parallelism-cap-actions',
      'board-prompts-link',
    ]) {
      expect(shown(id), `#${id} was up before any read`).toBe(false);
    }
    // The press itself paints the popover. Read the tree with no await at all
    // — the same instant the browser would have painted it.
    p.open();
    expect(shown('board-review-criteria')).toBe(false);
    expect(shown('board-prompts-link')).toBe(false);
    // Control: an Owner gets them back once the read lands, so the "put away"
    // above is a state the panel leaves rather than one it is stuck in.
    document.body.innerHTML = '';
    const owner = panel('owner');
    await owner.opened();
    expect(shown('board-review-criteria')).toBe(true);
    expect(shown('board-prompts-link')).toBe(true);
  });

  it('leaves the Owner’s panel as it was — the editors, the Saves and the link', async () => {
    const p = panel('owner');
    await p.opened();
    expect(shown('board-review-criteria')).toBe(true);
    expect(shown('board-review-criteria-actions')).toBe(true);
    expect(shown('board-parallelism-cap')).toBe(true);
    expect(shown('board-parallelism-cap-actions')).toBe(true);
    expect(shown('board-prompts-link')).toBe(true);
    expect(shown('board-review-criteria-text')).toBe(false);
    expect(shown('board-parallelism-cap-text')).toBe(false);
    // The editors hold the board's values, and the notes still say what the
    // words and the number are.
    expect((document.getElementById('board-review-criteria') as HTMLTextAreaElement).value).toBe(
      CRITERIA,
    );
    expect((document.getElementById('board-parallelism-cap') as HTMLInputElement).value).toBe(
      String(CAP),
    );
    expect(document.getElementById('board-review-criteria-note')?.textContent).not.toBe('');
    // And the Saves still save: the owner's panel writes where it always did.
    (document.getElementById('board-review-criteria-save') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.sent.map((s) => s.method)).toContain('PUT');
  });
});
