/**
 * The settings field that says what makes a good review item.
 *
 * Bryan, 2026-08-29, asking for the quality gate: *"let's have a criteria for
 * what makes a good review item. Something we can change in the settings.
 * It's a natural language prompt."* The gate shipped with the prompt reachable
 * only from an MCP tool and a raw PUT, so the owner could not read what his
 * agents were being judged against, let alone change it (UX review). This is
 * that field.
 *
 * Its own module, like `push-toggle.ts` next door, for the same reason: the
 * behaviour worth pinning is what the field does when the read fails, when
 * the box is empty, and when an agent rewrites the criteria while the panel
 * sits open — none of which is reachable from inside `board-app`'s `main()`.
 */

export interface ReviewCriteria {
  value: string;
  /** True while this board has never written its own — the field is showing
   *  the shipped default, and saying so is the point. */
  isDefault: boolean;
}

export interface ReviewCriteriaDeps {
  box: HTMLTextAreaElement;
  note: HTMLElement;
  save: HTMLButtonElement;
  useDefault: HTMLButtonElement;
  /** Where the criteria are drawn for a reader who may not change them. It
   *  and the editor are never up together — see `showEditor`. */
  text: HTMLElement;
  /** The Save / Use-the-default pair, as one element: hiding the two buttons
   *  individually would leave their flex row's gap behind. */
  actions: HTMLElement;
  /** May this reader write the criteria? Read on every refresh rather than
   *  captured, because the panel learns the role from the same members read
   *  that draws "Who has access" and that read happens on every open. */
  canEdit: () => boolean;
  /** Read the board's criteria. `null` is a failed read, never empty text. */
  read: () => Promise<ReviewCriteria | null>;
  /** Write them. `null` restores the shipped default. Resolves false when the
   *  write was refused, and the field keeps the reader's words. */
  write: (value: string | null) => Promise<boolean>;
  /** The board's one-line report. */
  toast: (message: string) => void;
}

export interface ReviewCriteriaHandle {
  /** Re-read and repaint. Called every time the panel opens. */
  refresh(): Promise<void>;
  /** Resolves when any in-flight write has finished. Tests await it. */
  settled(): Promise<void>;
}

/** What the note says under the field. The default's line names what the
 *  words DO, because a reader meeting them for the first time has no other
 *  way to know every ask on the board is measured against them. */
export function criteriaNote(criteria: ReviewCriteria): string {
  return criteria.isDefault
    ? 'The default. Every agent’s ask on this board is judged against it — edit it to say what you want.'
    : 'Edited for this board.';
}

export function mountReviewCriteria(deps: ReviewCriteriaDeps): ReviewCriteriaHandle {
  let inFlight: Promise<void> | null = null;

  /**
   * Put up the editor or the plain text, and say which is now up.
   *
   * A Regular User's PUT on this board's settings is refused by the server
   * (`requireOwner`, `routes/workspace-settings.ts`), so drawing them a
   * textarea and a Save is drawing a control that fails when used. The
   * missing control is not the enforcement — the refusal is the server's, as
   * it is for the members list next door — but a panel that shows what a
   * reader may do is the difference between a board that reads honestly and
   * one that lies until you press something.
   */
  function showEditor(): boolean {
    const editable = deps.canEdit();
    deps.box.classList.toggle('hidden', !editable);
    deps.actions.classList.toggle('hidden', !editable);
    deps.text.classList.toggle('hidden', editable);
    return editable;
  }

  async function refresh(): Promise<void> {
    const editable = showEditor();
    const criteria = await deps.read();
    if (!criteria) {
      // Disabled, not empty. An empty box that a reader then saves would
      // write empty criteria over the board's real ones — a failed READ must
      // never become a destructive WRITE.
      deps.box.disabled = true;
      deps.save.disabled = true;
      deps.useDefault.disabled = true;
      deps.text.textContent = '';
      deps.note.textContent = 'Could not read the criteria — reopen this panel to try again.';
      return;
    }
    deps.box.disabled = false;
    deps.save.disabled = false;
    deps.useDefault.disabled = false;
    deps.box.value = criteria.value;
    deps.text.textContent = criteria.value;
    // The note tells a reader what editing these words would do, so it goes
    // with the editor. Nothing takes its place: a read-only field is the
    // value where the control was, and not a sentence about who may change it.
    deps.note.textContent = editable ? criteriaNote(criteria) : '';
  }

  async function write(value: string | null): Promise<void> {
    const ok = await deps.write(value);
    if (!ok) {
      deps.toast('Could not save the criteria');
      return;
    }
    // Re-read rather than trusting what we sent: the server is what decides
    // whether these are now "edited for this board", and a restore-to-default
    // has to come back with the default's own words to put in the box.
    await refresh();
    deps.toast(value === null ? 'Criteria back to the default' : 'Criteria saved');
  }

  function run(value: string | null): void {
    inFlight = write(value).finally(() => {
      inFlight = null;
    });
  }

  deps.save.addEventListener('click', () => {
    const value = deps.box.value.trim();
    if (value === '') {
      // An empty box is a slip far more often than a request for no criteria
      // at all, and "no criteria" already has its own button. Refusing here
      // is what keeps a stray select-all-delete from turning the gate off.
      deps.toast('Criteria cannot be empty — use “Use the default” instead');
      return;
    }
    run(value);
  });
  deps.useDefault.addEventListener('click', () => run(null));

  return {
    refresh,
    settled: async () => {
      await inFlight;
    },
  };
}
