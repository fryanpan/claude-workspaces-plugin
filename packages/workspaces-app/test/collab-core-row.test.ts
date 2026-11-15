/**
 * The "Collab core" row on the board's settings page (`collab-core-row.ts`):
 * the owner moves the board onto the collab core with one tap, a reader who
 * cannot change it sees the state disabled, a server that fixes the core off
 * says so, and an open page follows a change made elsewhere without a reload.
 *
 * The first cases drive the real shell and the real settings wiring, as
 * `board-settings-members-panel.test.ts` does; the live case boots the whole
 * board against the fake server and feed.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { wireBoardSettingsPanel } from '../src/board/board-settings-panel.ts';
import { buildShell } from '../src/board/board-shell.ts';
import { COLLAB_CORE_LOCKED_NOTE, COLLAB_CORE_NOTE } from '../src/board/collab-core-row.ts';
import { applyCollabCore } from '../src/board/presence-core-switch.ts';
import { FakeEventSource } from './boot-harness.ts';
import {
  WS as BOOT_WS,
  bootTestBoard,
  resetBoardServerWith,
  settle,
} from './support/board-drive.ts';

const WS = 'w-hbl';

afterEach(() => {
  applyCollabCore(null);
  document.body.innerHTML = '';
});

const box = () => document.getElementById('board-collab-core') as HTMLInputElement;
const note = () => document.getElementById('board-collab-core-note')?.textContent;

interface Sent {
  path: string;
  method: string;
  body: unknown;
}

/** The real shell and settings wiring, as the owner or a Regular User, with
 *  the server answering the switch with `answer` (null refuses it). */
function panel(role: 'owner' | 'member', answer: Record<string, unknown> | null) {
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
  const sent: Sent[] = [];
  const toasts: string[] = [];
  wireBoardSettingsPanel({
    document,
    el,
    workspaceId: WS,
    author: { id: 'u-reader', name: 'Reader' },
    user: { id: 'u-reader', name: 'Reader' },
    fetchJson: async <T>(path: string): Promise<T | null> =>
      path.endsWith('/members')
        ? ({ you: { email: null, role }, members: [] } as unknown as T)
        : null,
    send: async (path, method, body) => {
      sent.push({ path, method, body });
      return path.endsWith('/collab-core')
        ? { ok: answer !== null, data: answer }
        : { ok: true, data: null };
    },
    showToast: (m) => toasts.push(m),
    isOpen: () => open,
    setOpen: (next) => {
      open = next;
    },
    onOpen: () => {},
    renderSettingsPanel: () => {},
    href: () => `/workspaces/${WS}`,
    estimatesShown: () => false,
  });
  const opened = async () => {
    el('board-settings').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // The level lands with the members read; poll for it rather than count turns.
    for (let i = 0; i < 50 && box().disabled === (role === 'owner'); i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  const tap = async () => {
    box().checked = !box().checked;
    box().dispatchEvent(new Event('change'));
    for (let i = 0; i < 50 && box().disabled; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  return { sent, toasts, opened, tap };
}

describe('the owner’s collab core switch', () => {
  it('moves the board on with one request carrying both settings, and back with one', async () => {
    const p = panel('owner', { active: true, on: true, serverWide: true, fixed: null });
    await p.opened();
    expect(box().disabled).toBe(false);
    expect(box().checked).toBe(false);
    expect(note()).toBe(COLLAB_CORE_NOTE);

    await p.tap();
    expect(p.sent).toEqual([
      {
        path: `/workspaces/${WS}/collab-core`,
        method: 'POST',
        body: { on: true, serverWide: true },
      },
    ]);
    expect(box().checked).toBe(true);
  });

  it('turns only the board off', async () => {
    applyCollabCore({ collabCore: { active: true, fixed: null } });
    const p = panel('owner', { active: false, on: false, serverWide: true, fixed: null });
    await p.opened();
    expect(box().checked).toBe(true);
    await p.tap();
    expect(p.sent.map((s) => s.body)).toEqual([{ on: false }]);
    expect(box().checked).toBe(false);
  });

  it('puts the box back and says so when the server refuses', async () => {
    const p = panel('owner', null);
    await p.opened();
    await p.tap();
    expect(box().checked).toBe(false);
    expect(p.toasts).toEqual(['Could not move this board. Nothing changed.']);
  });

  it('is shown but disabled for a Regular User', async () => {
    applyCollabCore({ collabCore: { active: true, fixed: null } });
    const p = panel('member', null);
    await p.opened();
    expect(box().checked).toBe(true);
    expect(box().disabled).toBe(true);
  });

  it('is disabled for the owner too, and says why, when the server fixes it off', async () => {
    applyCollabCore({ collabCore: { active: false, fixed: 'off' } });
    const p = panel('owner', null);
    await p.opened();
    // The positive control for the level: the members read made this reader
    // the owner, so only the lock can be holding the box.
    expect(document.getElementById('board-access-link')?.classList.contains('hidden')).toBe(false);
    expect(box().disabled).toBe(true);
    expect(note()).toBe(COLLAB_CORE_LOCKED_NOTE);
  });
});

describe('an open board page follows a switch made elsewhere', () => {
  it('ticks and unticks the box from the board’s stream, without a reload', async () => {
    resetBoardServerWith({
      collabCore: { active: false, on: false, serverWide: false, fixed: null },
    });
    await bootTestBoard();
    expect(box().checked).toBe(false);
    const feed = async (active: boolean) => {
      FakeEventSource.last().dispatchEvent(
        Object.assign(new Event('collab-core.changed'), {
          data: JSON.stringify({ event: 'collab-core.changed', workspaceId: BOOT_WS, active }),
        }),
      );
      await settle();
    };
    await feed(true);
    expect(box().checked).toBe(true);
    await feed(false);
    expect(box().checked).toBe(false);
  });
});
