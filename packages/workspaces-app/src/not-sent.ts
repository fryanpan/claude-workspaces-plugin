/**
 * What a composer says when the comment in it never reached the server.
 *
 * Every comment box on every surface already put the words BACK in the box
 * when a post was refused, and every one of them said so in a toast that was
 * gone three and a half seconds later — or, on the plain reply path, said
 * nothing at all. So the box a reader looked back at held their sentence and
 * no account of itself: identical to a draft they simply never sent. That is
 * the state this module exists to remove (a comment left on 15 September
 * 2026 reached no board, and silence and a lost comment looked the same).
 *
 * The state and the way out of it are ONE control: a button reading
 * "Not sent — tap to retry" sitting beside the draft it belongs to. It is not
 * an explanation — the reader does not need the status code, they need to
 * know the words are still theirs and how to send them again.
 *
 * It clears on three events, and all three are the reason it is honest:
 * a retry (the state is being re-decided), a successful post from the same
 * box (`clearNotSent`), and the reader typing (whatever they are writing now
 * is not what failed).
 */

const NOTE_CLASS = 'not-sent';
const RETRY_CLASS = 'not-sent-retry';

/** Default wording. Plain, calm, and the same on every surface. */
export const NOT_SENT_LABEL = 'Not sent — tap to retry';

export interface NotSentOpts {
  /** The note is inserted immediately BEFORE this element — the send button,
   *  or whatever sits closest to the draft. */
  near: Element;
  /** The box holding the draft. Typing in it clears the note. */
  field: HTMLTextAreaElement | HTMLInputElement;
  /** Send the same words again. The note goes first, so a second failure
   *  draws a fresh one rather than leaving a stale one standing. */
  retry: () => void;
  /** Override the wording (the new-thread composer says "comment"). */
  label?: string;
}

/**
 * Put the "not sent" state on the composer `near` sits in, replacing any
 * note already there. Returns the note so a caller can read it in a test.
 */
export function markNotSent(opts: NotSentOpts): HTMLElement {
  const { near, field, retry } = opts;
  const scope = near.parentElement ?? near;
  clearNotSent(scope);
  const note = document.createElement('p');
  note.className = NOTE_CLASS;
  // `alert` rather than `status`: the reader believes the comment is gone
  // to the agent, and a screen reader that waits for a quiet moment to say
  // otherwise is the same silence in another form.
  note.setAttribute('role', 'alert');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = RETRY_CLASS;
  button.textContent = opts.label ?? NOT_SENT_LABEL;
  button.addEventListener('click', () => {
    note.remove();
    retry();
  });
  note.appendChild(button);
  near.insertAdjacentElement('beforebegin', note);
  // Not `{ once: true }` on the field: the note can be redrawn by a second
  // failure, and a listener spent on the first one would leave the second
  // standing over words typed since.
  const onInput = (): void => {
    note.remove();
    field.removeEventListener('input', onInput);
  };
  field.addEventListener('input', onInput);
  return note;
}

/** Take the state off `scope` — a post landed, or a retry is under way. */
export function clearNotSent(scope: ParentNode): void {
  for (const n of Array.from(scope.querySelectorAll(`.${NOTE_CLASS}`))) n.remove();
}
