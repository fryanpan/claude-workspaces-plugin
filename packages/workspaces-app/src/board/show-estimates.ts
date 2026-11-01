/**
 * The "Show estimates" row on the board's settings page (Bryan, 1 Nov: "add
 * a setting to hide all the estimations … default to having the setting off
 * on all boards").
 *
 * The box follows the BOARD, not a read made when the page opened: its state
 * is painted from the board doc every time the doc moves, so a change made on
 * another page or by an agent shows here within the same second it shows on
 * the board. A tap writes through `PUT /workspaces/<id>/settings`, and the
 * box is then repainted by the doc like any other change — so a refused write
 * is put back and said, never left looking saved.
 *
 * Board-wide configuration, so only the owner may change it; the server
 * refuses anyone else. A reader who cannot change it sees the state with the
 * box disabled rather than a control that fails.
 */

export interface ShowEstimatesDeps {
  toggle: HTMLInputElement;
  /** Whether this reader may change board settings, read at every paint. */
  canEdit(): boolean;
  /** Write the new value; resolves whether the server took it. */
  write(show: boolean): Promise<boolean>;
  toast(message: string): void;
}

export interface ShowEstimatesRow {
  /** Paint the row from the board's current setting. */
  paint(shown: boolean): void;
  /** Re-apply who may change it, keeping the current state. */
  applyLevel(): void;
}

export function mountShowEstimates(deps: ShowEstimatesDeps): ShowEstimatesRow {
  const { toggle } = deps;
  let shown = false;
  let saving = false;
  const applyLevel = (): void => {
    toggle.disabled = saving || !deps.canEdit();
  };
  const paint = (next: boolean): void => {
    shown = next;
    toggle.checked = next;
    applyLevel();
  };
  toggle.addEventListener('change', () => {
    const want = toggle.checked;
    saving = true;
    applyLevel();
    void deps.write(want).then((ok) => {
      saving = false;
      if (ok) {
        // The board doc confirms it; until it lands, show what was chosen.
        shown = want;
      } else {
        deps.toast('Could not change Show estimates. Nothing changed.');
      }
      paint(shown);
    });
  });
  paint(false);
  return { paint, applyLevel };
}
