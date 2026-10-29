/**
 * What a comment or reply box does with Enter. One rule for every box — the
 * task panel, doc threads and diff lines, the board's thread cards, and the
 * widget on a mock — so a reader's Enter does the same thing wherever they
 * are typing.
 *
 * Enter sends, and so does Cmd/Ctrl+Enter; Shift+Enter is a new line. An
 * IME's Enter picks a candidate, so a composing keystroke is never a send:
 * Chrome says `isComposing`, and Safari sends the committing Enter with
 * `isComposing` false and keyCode 229.
 *
 * A send key is consumed — that `preventDefault` is also what stops a
 * markdown composer's editor inserting a paragraph under the send
 * (`md-composer.ts` honours a consumed proxy) — and handed to `send`, the
 * same function the box's button calls. So an empty box refuses Enter
 * exactly as it refuses the button: every `send` checks for words first,
 * and the task panel's says "Write something first".
 *
 * Structural, not `KeyboardEvent` and `HTMLTextAreaElement`: core touches no
 * DOM. Written as one condition because the widget ships it and its bundle
 * sat 52 bytes under its ceiling when this landed (`check-widget-size.ts`).
 */
export interface SendKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  keyCode: number;
  preventDefault(): void;
}

type SendKeyListener = (ev: SendKeyEvent) => void;

/** The keydown listener for a box, for a caller that registers listeners
 *  through its own teardown scope. */
export function sendKeyListener(send: () => void): SendKeyListener {
  return (ev) => {
    if (
      ev.key !== 'Enter' ||
      ev.isComposing ||
      ev.keyCode === 229 ||
      (ev.shiftKey && !ev.metaKey && !ev.ctrlKey)
    )
      return;
    ev.preventDefault();
    send();
  };
}

/** Wire a box to the rule, for a box whose listeners die with it. */
export function sendOnEnter(
  field: { addEventListener(type: 'keydown', fn: SendKeyListener): void },
  send: () => void,
): void {
  field.addEventListener('keydown', sendKeyListener(send));
}
