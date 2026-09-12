/**
 * The workspace settings panel: the three controls inside it, what each one
 * reads and writes, and when the panel itself opens and closes.
 *
 * One responsibility, and the reason it is one: every control here is read
 * from the server at the moment the panel opens rather than held in the
 * board's projection, because an agent can change any of the three from a
 * tool while this tab sits on the page. That rule — open means re-read —
 * has to be stated once for all of them, and it was stated three times in
 * the middle of `bootBoard`'s wiring section before this file existed.
 *
 * The share button rides along because it is the panel's neighbour in the
 * top-right cluster and its only other reader of `showToast`.
 *
 * Nothing here can reach the board: `BoardSettingsPanelDeps` is the whole list,
 * and the open flag arrives as a two-thunk accessor rather than as the
 * `BoardState` it actually lives on.
 */
import { type BoardMembersView, type BoardRole, mountBoardMembers } from './board-members.ts';
import { mountParallelismCap } from './parallelism-cap.ts';
import { mountPushToggle } from './push-toggle.ts';
import { mountReviewCriteria } from './review-criteria.ts';

/** Everything the settings panel needs from `bootBoard`, and nothing else. */
export interface BoardSettingsPanelDeps {
  document: Document;
  /** `getElementById`, already narrowed to a present element — `bootBoard`'s
   *  own `el`, so a missing container throws here exactly as it does there. */
  el(id: string): HTMLElement;
  /** The board this panel is the settings for. */
  workspaceId: string;
  /** Who the writes are attributed to. Read per call: the identity is
   *  settled before this mounts, but the shape is the actions layer's. */
  author: { id: string; name: string; kind?: string; color?: string };
  /** The signed-in reader, for the push subscription's own author field. */
  user: { id: string; name: string };
  fetchJson<T>(path: string): Promise<T | null>;
  send(path: string, method: string, body: unknown): Promise<{ ok: boolean }>;
  showToast(message: string): void;
  /** The panel's open flag, which lives on `BoardState`. Two thunks rather
   *  than the state object: this file has no other business with it. */
  isOpen(): boolean;
  setOpen(open: boolean): void;
  /** Paint the open/closed state. `bootBoard` owns the render layer. */
  renderSettingsPanel(): void;
  /** The address the share button copies. */
  href(): string;
}

/**
 * Mount the panel's controls and wire the ways it opens and closes.
 *
 * Called once, from `bootBoard`'s wiring section, in the same position the
 * inlined block held — the click listeners it registers on `document` are
 * order-sensitive against the ones around them.
 */
export function wireBoardSettingsPanel(deps: BoardSettingsPanelDeps): void {
  const { document, el, workspaceId, author, user, fetchJson, send, showToast } = deps;
  /**
   * What this reader may CHANGE here, as of the last members read.
   *
   * Three of this panel's rows are board-wide configuration and the server
   * refuses a Regular User's write of all three — the criteria and the cap
   * through `requireOwner` on `PUT /workspaces/<id>/settings`, the prompts
   * page because it is trusted-local and no share visitor reaches it at all.
   * So the panel draws them as what they are for this reader.
   *
   * FALSE UNTIL PROVEN, including after a failed read: the cost of guessing
   * wrong downward is an owner who reopens the panel, and of guessing wrong
   * upward is exactly the control-that-fails this exists to remove.
   */
  let canEdit = false;
  // Notifications for THIS device. Mounted once; its state is read from the
  // browser rather than held here, because the browser is where it actually
  // lives — a permission revoked in site settings has to show up on the row
  // without the app being told.
  const pushToggle = mountPushToggle({
    toggle: document.getElementById('board-push-toggle') as HTMLInputElement,
    note: el('board-push-note'),
    author: () => ({ id: user.id, name: user.name }),
  });
  void pushToggle.refresh();

  // What the quality gate judges an agent's ask against, in the owner's own
  // words. Read on every open, because an agent can rewrite it from a tool
  // while this tab sits here and a stale box that got saved would put the old
  // words back.
  const reviewCriteria = mountReviewCriteria({
    box: document.getElementById('board-review-criteria') as HTMLTextAreaElement,
    note: el('board-review-criteria-note'),
    save: el('board-review-criteria-save') as HTMLButtonElement,
    useDefault: el('board-review-criteria-default') as HTMLButtonElement,
    text: el('board-review-criteria-text'),
    actions: el('board-review-criteria-actions'),
    canEdit: () => canEdit,
    read: async () => {
      const data = await fetchJson<{
        reviewItemCriteria?: { value?: string; isDefault?: boolean };
      }>(`/workspaces/${encodeURIComponent(workspaceId)}/settings`);
      const criteria = data?.reviewItemCriteria;
      return typeof criteria?.value === 'string'
        ? { value: criteria.value, isDefault: criteria.isDefault === true }
        : null;
    },
    write: async (value) => {
      const res = await send(`/workspaces/${encodeURIComponent(workspaceId)}/settings`, 'PUT', {
        reviewItemCriteria: value,
        author,
      });
      return res.ok;
    },
    toast: showToast,
  });

  // How many builders this board's lead may dispatch at once, and how many
  // of that are already spent. Read on every open for the same reason as the
  // criteria above: an agent can change the cap or open a dispatch from a
  // tool while this tab sits here, and a stale box that got saved would
  // write the old number back over a change nobody here saw happen.
  const parallelismCap = mountParallelismCap({
    box: document.getElementById('board-parallelism-cap') as HTMLInputElement,
    note: el('board-parallelism-cap-note'),
    save: el('board-parallelism-cap-save') as HTMLButtonElement,
    useDefault: el('board-parallelism-cap-default') as HTMLButtonElement,
    text: el('board-parallelism-cap-text'),
    actions: el('board-parallelism-cap-actions'),
    canEdit: () => canEdit,
    read: async () => {
      const data = await fetchJson<{
        parallelismCap?: {
          value?: number;
          isDefault?: boolean;
          lastChange?: { actor?: { name?: string }; ts?: number; from?: number; to?: number };
        };
        dispatchesInUse?: number;
      }>(`/workspaces/${encodeURIComponent(workspaceId)}/settings`);
      const cap = data?.parallelismCap;
      const change = cap?.lastChange;
      const lastChange =
        typeof change?.actor?.name === 'string' &&
        typeof change.ts === 'number' &&
        typeof change.from === 'number' &&
        typeof change.to === 'number'
          ? { actorName: change.actor.name, ts: change.ts, from: change.from, to: change.to }
          : undefined;
      return typeof cap?.value === 'number'
        ? {
            value: cap.value,
            isDefault: cap.isDefault === true,
            ...(typeof data?.dispatchesInUse === 'number' ? { inUse: data.dispatchesInUse } : {}),
            ...(lastChange ? { lastChange } : {}),
          }
        : null;
    },
    write: async (value) => {
      const res = await send(`/workspaces/${encodeURIComponent(workspaceId)}/settings`, 'PUT', {
        parallelismCap: value,
        author,
      });
      return res.ok;
    },
    toast: showToast,
  });

  // Who can reach this board, and at what level. Read on every open like the
  // two above, and for a sharper reason: the list is what a person checks
  // BEFORE deciding something is safe to put here, so a stale one is worse
  // than none. The controls are drawn only for an Owner; the routes behind
  // them refuse a Regular User server-side either way.
  const members = mountBoardMembers({
    list: el('board-members-list'),
    note: el('board-members-note'),
    read: async () => {
      const data = await fetchJson<BoardMembersView>(
        `/workspaces/${encodeURIComponent(workspaceId)}/members`,
      );
      if (!data || typeof data.you?.role !== 'string' || !Array.isArray(data.members)) return null;
      return data;
    },
    setRole: async (email, role) => {
      const res = await send(
        `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(email)}/role`,
        'POST',
        { role },
      );
      return res.ok;
    },
    remove: async (email) => {
      const res = await send(
        `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(email)}`,
        'DELETE',
        {},
      );
      return res.ok;
    },
    toast: showToast,
    onRole: (role: BoardRole | null) => {
      canEdit = role === 'owner';
      // A page address, not a control, and still the same bug: the prompts
      // page is trusted-local, so for a Regular User this row is a link that
      // leads to a refusal. It goes rather than greys out — there is nothing
      // to read there that they could have read.
      el('board-prompts-link').classList.toggle('hidden', !canEdit);
    },
  });

  /**
   * Re-read who you are, THEN what the rest of the panel shows.
   *
   * Ordered rather than fanned out with the others: the criteria and the cap
   * draw differently for an Owner than for a Regular User, so a read that
   * landed first would paint an editor and swap it for text a turn later —
   * the flicker being a control the reader may have already reached for.
   */
  async function refreshRoleAndBoardSettings(): Promise<void> {
    await members.refresh();
    await Promise.all([reviewCriteria.refresh(), parallelismCap.refresh()]);
  }

  el('board-settings').addEventListener('click', () => {
    deps.setOpen(!deps.isOpen());
    deps.renderSettingsPanel();
    // Re-read on open: permission can change in site settings while the tab
    // sits here, and the row is only ever read at the moment it is opened.
    // Same reason for the criteria, which an agent can rewrite from a tool.
    if (deps.isOpen()) {
      void pushToggle.refresh();
      void refreshRoleAndBoardSettings();
    }
  });
  // A popover that only closes by hitting the same small button again is one
  // people leave open over the list they were trying to read.
  document.addEventListener('click', (ev) => {
    if (!deps.isOpen()) return;
    const t = ev.target as Node | null;
    if (!t) return;
    // Reads the tree as it is NOW, which is after every handler inside the
    // panel has run. A control that repaints its own section from a click
    // handler has detached the button by this point, and the click that
    // started inside the panel would test as one outside it and close the
    // whole panel under the person who tapped. That is why the members list
    // repaints on a later turn (`board-members.ts`), and why a new control in
    // here must not repaint synchronously either.
    if (el('board-settings-panel').contains(t) || el('board-settings').contains(t)) return;
    deps.setOpen(false);
    deps.renderSettingsPanel();
  });
  // Escape closes it too — it floats over the board now, and a floating panel
  // that ignores Escape reads as stuck. Focus goes back to the button that
  // opened it, so a keyboard user is not dropped at the top of the document.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !deps.isOpen()) return;
    deps.setOpen(false);
    deps.renderSettingsPanel();
    el('board-settings').focus();
  });
  el('board-share').addEventListener('click', () => {
    void navigator.clipboard?.writeText(deps.href()).then(
      () => showToast('Workspace URL copied'),
      () => showToast(deps.href()),
    );
  });
}
