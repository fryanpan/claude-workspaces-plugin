/**
 * Whether a document mounts editable — which is now the same question as
 * whether this browser is allowed to write at all.
 *
 * There used to be a pencil in the top bar and a stored `lf:edit-mode`
 * preference behind it, and the pair was wrong twice over. A review surface
 * that opens read-only asks every writer for one tap before their first word,
 * on every doc, forever; and the preference could not answer the question it
 * was being asked, because the SERVER decides whether writing is possible.
 *
 * The mount used to read the preference, make the document editable, and only
 * then ask `/api/auth/session`. For one round trip — 0ms on loopback, ~200ms
 * over a Cloudflare Tunnel, which is this product's stated deployment — the
 * doc was live: it took typing, said "Unsaved changes", and then reverted with
 * no modal and no toast when the answer landed. The words were never in the
 * ydoc (the socket is read-only server-side) and were gone on reload. Prose
 * rides the yjs socket, so there is no HTTP 401 to catch it afterwards.
 *
 * So the answer is an ARGUMENT here, and `initialEditMode` is the only way in.
 * A caller that has not got the answer cannot express the question.
 */

export type EditMode = 'view' | 'edit';

/**
 * The mode a surface mounts in, given what the server already said.
 *
 * `canWrite` comes from the session answer `main()` awaits before the router
 * starts, carried to every mount on `MountContext`. A browser that may write
 * opens ready to write; one that may not gets the same page with editing off
 * and no control offering to turn it on.
 */
export function initialEditMode(canWrite: boolean): EditMode {
  return canWrite ? 'edit' : 'view';
}
