/**
 * The "Collab core" row on the board's settings page: the owner moves this
 * board's live editing onto the collab core, or back, with one tap.
 *
 * The box shows `collabCoreActive` (`presence-core-switch.ts`), which the
 * board record, the `collab-core.changed` frame and the re-read after a
 * stream gap keep current, so a switch made on another page shows here
 * without a reload. Ticking it sends the board's setting AND the server-wide
 * one in one request, because a board takes the core only while both are on
 * and the owner should not have to know there are two. Unticking turns only
 * this board off.
 *
 * Owner only, and the server is the enforcement: turning it on needs the
 * owner's own proof. A reader who cannot change it sees the state with the
 * box disabled. A server whose launch environment fixes the core off
 * (`CW_COLLAB_CORE`) draws the box disabled for everyone and says why.
 */
import { effect } from '@preact/signals';
import { applyCollabCore, collabCoreActive, collabCoreLockedOff } from './presence-core-switch.ts';

export interface CollabCoreRowDeps {
  toggle: HTMLInputElement;
  note: HTMLElement;
  /** Whether this reader may change board settings, read at every paint. */
  canEdit(): boolean;
  /** Send the request; resolves to the server's answer, or null when it
   *  refused or could not be reached. */
  write(body: { on: boolean; serverWide?: boolean }): Promise<unknown | null>;
  toast(message: string): void;
}

export interface CollabCoreRow {
  /** Re-apply who may change it, keeping the current state. */
  applyLevel(): void;
  /** Stop following the signals. */
  dispose(): void;
}

export const COLLAB_CORE_NOTE =
  "Runs this board's live editing on the new sync engine. Open pages move over when they reconnect.";
export const COLLAB_CORE_LOCKED_NOTE = 'Turned off for this server by its launch settings.';

export function mountCollabCoreRow(deps: CollabCoreRowDeps): CollabCoreRow {
  const { toggle, note } = deps;
  let saving = false;
  const applyLevel = (): void => {
    toggle.disabled = saving || collabCoreLockedOff.value || !deps.canEdit();
  };
  const dispose = effect(() => {
    toggle.checked = collabCoreActive.value;
    note.textContent = collabCoreLockedOff.value ? COLLAB_CORE_LOCKED_NOTE : COLLAB_CORE_NOTE;
    applyLevel();
  });
  toggle.addEventListener('change', () => {
    const want = toggle.checked;
    saving = true;
    applyLevel();
    void deps.write(want ? { on: true, serverWide: true } : { on: false }).then((answer) => {
      saving = false;
      // The answer carries the same fields as the frame every other page
      // hears; a refused change is put back.
      if (answer !== null) applyCollabCore(answer);
      else deps.toast('Could not move this board. Nothing changed.');
      toggle.checked = collabCoreActive.value;
      applyLevel();
    });
  });
  return { applyLevel, dispose };
}
