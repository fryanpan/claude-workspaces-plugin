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

afterEach(() => {
  document.body.innerHTML = '';
});

function panel(): { isOpen: () => boolean; open: () => void } {
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
  wireBoardSettingsPanel({
    document,
    el,
    workspaceId: WS,
    author: { id: 'u-owner', name: 'Owner' },
    user: { id: 'u-owner', name: 'Owner' },
    fetchJson: async <T>(path: string): Promise<T | null> =>
      path.endsWith('/members')
        ? ({
            you: { email: null, role: 'owner' },
            members: [{ email: KEEPER, role: 'member' }],
          } as unknown as T)
        : null,
    send: async () => ({ ok: true }),
    showToast: () => {},
    isOpen: () => open,
    setOpen: (next) => {
      open = next;
    },
    renderSettingsPanel: () => {
      el('board-settings-panel').classList.toggle('hidden', !open);
    },
    href: () => `/workspaces/${WS}`,
  });
  return {
    isOpen: () => open,
    open: () => el('board-settings').dispatchEvent(new MouseEvent('click', { bubbles: true })),
  };
}

describe('the settings panel and its members subsection', () => {
  it('stays open when Remove is tapped, and shows the confirmation', async () => {
    const p = panel();
    p.open();
    await Promise.resolve();
    await Promise.resolve();
    const remove = document.querySelector<HTMLButtonElement>(
      '#board-members-list .board-member-remove',
    );
    expect(remove).not.toBeNull();
    remove?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // The document listener has already run — it is part of the same dispatch
    // — so the panel's fate is settled before the repaint this waits for.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The panel is still open — the click began inside it, whatever the
    // button's fate by the time the document listener reads the tree.
    expect(p.isOpen()).toBe(true);
    expect(document.getElementById('board-settings-panel')?.classList.contains('hidden')).toBe(
      false,
    );
    // And the tap did what it is for: the row now asks, naming the person.
    const confirm = document.querySelector('#board-members-list .board-member--confirm');
    expect(confirm?.textContent).toContain(`Remove ${KEEPER}?`);
  });

  it('still closes when the click really was outside', async () => {
    const p = panel();
    p.open();
    await Promise.resolve();
    expect(p.isOpen()).toBe(true);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(p.isOpen()).toBe(false);
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
