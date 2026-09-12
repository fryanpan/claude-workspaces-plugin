/**
 * The mount-time edit-mode decision — the one that decides whether a document
 * is typeable in its first frame.
 *
 * This is a regression suite for a measured bug. The mount used to read a
 * stored `lf:edit-mode` preference, call `setEditable(true)`, and only then
 * ask `/api/auth/session`; the document was live for exactly one session
 * round trip, which measured 0ms on loopback, 197ms with 200ms of injected
 * latency and 594ms with 600ms — and this product's stated deployment is a
 * Cloudflare Tunnel, where that range is ordinary. Text typed in the window
 * appeared, said "Unsaved changes", reverted with no modal and no toast when
 * the answer landed, and was gone on reload: never in the ydoc (the socket is
 * read-only server-side) and never on disk. Prose rides the yjs socket, so no
 * HTTP 401 exists to catch it afterwards.
 *
 * The preference is gone with the pencil that wrote it, so there is one input
 * left — and it is the server's own answer.
 */
import { describe, expect, it } from 'vitest';
import { initialEditMode } from '../src/edit-mode.ts';

describe('the mode a doc MOUNTS in', () => {
  it('is edit for a browser the server will accept writes from', () => {
    // A review surface opens ready to write. There is no control to press
    // first, so this answer is the whole of the feature.
    expect(initialEditMode(true)).toBe('edit');
  });

  // The bug, stated as a test: the exact state the reviewer reproduced — a
  // server that will not take this browser's writes.
  it('is view when the server refuses this browser', () => {
    expect(initialEditMode(false)).toBe('view');
  });

  it('reads nothing but its argument', () => {
    // Storage used to be able to overturn the server's answer. Nothing this
    // function can see now says otherwise, whatever an old install left
    // behind under the key the pencil used to write.
    localStorage.setItem('lf:edit-mode', 'edit');
    expect(initialEditMode(false)).toBe('view');
    localStorage.setItem('lf:edit-mode', 'view');
    expect(initialEditMode(true)).toBe('edit');
    localStorage.removeItem('lf:edit-mode');
  });
});
