import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attach, installSheets, styleOf } from './css-harness.ts';

/**
 * A Can view reader (`doc-gates.ts` sets `role-view` on the body) reads a
 * thread but cannot reply to it or resolve it: the server refuses both, and
 * a Resolve that answers "try again" can never succeed. So the card draws
 * neither control for them, and still draws both for everyone else.
 */
let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('board.css', 'styles.css', 'doc.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.body.classList.remove('role-view');
});

function card() {
  const thread = attach('thread');
  return {
    reply: styleOf(attach('thread-reply', { parent: thread })),
    resolve: styleOf(attach('thread-resolve', { tag: 'button', parent: thread })),
  };
}

describe('a thread card for a Can view reader', () => {
  it('draws Reply and Resolve for a reader who may use them', () => {
    const c = card();
    expect(c.reply.display).not.toBe('none');
    expect(c.resolve.display).not.toBe('none');
  });

  it('draws neither for a Can view reader', () => {
    document.body.classList.add('role-view');
    const c = card();
    expect(c.reply.display).toBe('none');
    expect(c.resolve.display).toBe('none');
  });
});
