/**
 * Sign-in: the one slot the app asks "who sent this request?".
 *
 * Every page and the doc socket read a person through `SignIn.principal`, so
 * a provider is swapped here and nowhere else. The kit's provider is
 * password sign-in (`password-sign-in.ts`).
 */
import type { Principal } from '@claude-workspaces/app-kit/collab';
import type { Hono } from 'hono';

export interface SignIn {
  /** Who sent this request, or null when nobody is signed in. */
  principal(req: Request): Principal | null | Promise<Principal | null>;
  /** The provider's own pages and callbacks. The app mounts them at `/auth`. */
  routes: Hono;
  /** Where a signed-out page is sent. */
  signInPath: string;
}

/**
 * Whether a request came from a page of this app. A request from another
 * site carries the person's cookie too, so every state-changing request and
 * every socket is refused without this.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}
