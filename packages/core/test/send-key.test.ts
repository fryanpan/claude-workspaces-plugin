import { describe, expect, it } from 'vitest';
import { type SendKeyEvent, sendKeyListener } from '../src/send-key.ts';

/** Press one key; answers whether it was handed to `send` and whether the
 *  key was consumed. */
function press(over: Partial<SendKeyEvent>): { sent: boolean; consumed: boolean } {
  let sent = false;
  let consumed = false;
  sendKeyListener(() => {
    sent = true;
  })({
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    keyCode: 13,
    preventDefault: () => {
      consumed = true;
    },
    ...over,
  });
  return { sent, consumed };
}

describe('sendKeyListener', () => {
  it('sends on Enter, Cmd+Enter and Ctrl+Enter, and consumes the key', () => {
    expect(press({})).toEqual({ sent: true, consumed: true });
    expect(press({ metaKey: true })).toEqual({ sent: true, consumed: true });
    expect(press({ ctrlKey: true })).toEqual({ sent: true, consumed: true });
    expect(press({ metaKey: true, shiftKey: true })).toEqual({ sent: true, consumed: true });
  });

  it('leaves Shift+Enter to the box as a new line', () => {
    expect(press({ shiftKey: true })).toEqual({ sent: false, consumed: false });
  });

  it('never sends a composing Enter, in either browser shape', () => {
    expect(press({ isComposing: true })).toEqual({ sent: false, consumed: false });
    expect(press({ keyCode: 229 })).toEqual({ sent: false, consumed: false });
  });

  it('ignores every other key', () => {
    expect(press({ key: 'a', keyCode: 65 })).toEqual({ sent: false, consumed: false });
    expect(press({ key: 'Escape', keyCode: 27 })).toEqual({ sent: false, consumed: false });
  });
});
