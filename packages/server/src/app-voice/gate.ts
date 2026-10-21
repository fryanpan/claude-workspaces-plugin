/**
 * Who may be handed an app voice token, and who may open the socket with
 * one. Pure, so each refusal is tested on its own.
 *
 * The socket spends the owner's Soniox key while it is open, and `say`
 * writes to a dev server on the owner's machine, so it is the owner's alone,
 * as the voice page and the voice API's token routes are
 * (`routes/voice-page.ts`, `refuseNonOwner`).
 *
 * Two decisions, made at two requests:
 *
 * - **Minting**, when the frame's HTML is served. The frame's own document
 *   request carries the reader's cookie, so the server knows who it is
 *   serving. A share or collaboration visitor and a signed-in person who is
 *   not the owner get a frame with no token. With nobody proven, a server
 *   that asks browsers to sign in gives none; one that does not (loopback,
 *   the tailnet) gives one, as every owner-only page there does.
 * - **Opening**, at the upgrade. The token is the credential: the opaque
 *   frame's own requests carry no cookie, so a socket it opens directly
 *   proves nobody, and the token is what says the owner was served this doc
 *   in the last ten minutes. On top of it a share visitor is refused, and so
 *   is a request that proves a person who is not the owner, so a token
 *   copied out of the owner's frame does not work for anyone else who is
 *   signed in. A socket the host page relays carries the reader's cookie and
 *   is judged the same way.
 *
 * `Origin` is not the credential. An opaque frame sends `null`, and so does
 * every other sandboxed page on the web. It is checked only to refuse a page
 * on some other site that has been handed a token: absent (not a browser),
 * `null`, this server's own origins and the frame-only hostname are let on to
 * the token check, and anything else is refused.
 */

export interface AppVoiceViewer {
  /** A share or collaboration visitor. */
  visitor: boolean;
  /** A person proof on this request names the owner. */
  ownerProven: boolean;
  /** A person proof on this request names somebody. */
  anyoneProven: boolean;
  /** This deployment asks a browser that proved nobody to sign in. */
  mustSignIn: boolean;
}

/** Whether the frame served to `v` carries a token. */
export function mayMintAppVoice(v: AppVoiceViewer): boolean {
  if (v.visitor) return false;
  if (v.ownerProven) return true;
  if (v.anyoneProven) return false;
  return !v.mustSignIn;
}

export interface AppVoiceUpgrade {
  visitor: boolean;
  ownerProven: boolean;
  anyoneProven: boolean;
  /** The request's `Origin` header, or null when it has none. */
  origin: string | null;
  /** Whether the origin is one this server lets a browser write from. */
  originAllowed: boolean;
  /** The frame-only hostname's origin, when configured. */
  frameOrigin: string | null;
  /** The token's verdict for this socket's board and doc. */
  token: { ok: true } | { ok: false; reason: string };
}

export type AppVoiceRefusal = { status: number; error: string };

/** Null when the socket may open, else why not. Order: who, where, then the token. */
export function refuseAppVoice(u: AppVoiceUpgrade): AppVoiceRefusal | null {
  if (u.visitor) return { status: 403, error: 'not available to share visitors' };
  if (u.anyoneProven && !u.ownerProven) return { status: 403, error: 'owner-only' };
  const fromPage =
    u.origin === null ||
    u.origin === 'null' ||
    u.originAllowed ||
    (u.frameOrigin !== null && u.origin === u.frameOrigin);
  if (!fromPage) return { status: 403, error: 'origin_not_allowed' };
  if (!u.token.ok) return { status: 401, error: 'app_voice_token_required' };
  return null;
}
