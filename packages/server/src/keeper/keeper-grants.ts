/**
 * What one approval opens afterwards.
 *
 * A setup grant comes from creating a project and covers its volume and
 * secrets. A move grant is asked for on its own (`POST /v1/move-grant`),
 * names one board on one app the keeper made or adopted, and covers the steps
 * in `keeper-move-steps.ts` on that app, and nothing else. Its request is
 * always a tap, so a live grant cannot renew itself.
 *
 * An Access grant comes from opening an Access application and covers that
 * application's policies.
 */
import { BOARD_ID, SECRET_NAME, moveSteps } from './keeper-move-steps.ts';
import type { Verdict } from './keeper-policy.ts';
import { APP_NAME } from './keeper-store.ts';

export interface MoveGrantCall {
  type: 'move-grant';
  app: string;
  board: string;
  /** Secret names the approval page lists; an import of any other is held. */
  secrets: string[];
}

/** A grant one approval opened: later held requests it covers run without a tap. */
export interface Grant {
  /** A Fly app (`fly`), or a Cloudflare path prefix (`cloudflare`). */
  scope: 'fly' | 'cloudflare';
  target: string;
  expiresAt: number;
  /** Set on a move grant: the one board it was opened for. */
  board?: string;
  /** On a move grant: the secret names the page listed. */
  secrets?: readonly string[];
}

export const SETUP_GRANT_MS = 30 * 60_000;
export const MOVE_GRANT_MS = 30 * 60_000;
export const ACCESS_GRANT_MS = 10 * 60_000;
const MAX_SECRETS = 32;

/** Hold for a tap, or refuse: never routine, and never covered by a grant. */
export function classifyMoveGrant(
  app: unknown,
  board: unknown,
  secrets: unknown,
  apps: readonly string[],
): Verdict {
  if (typeof app !== 'string' || !APP_NAME.test(app)) {
    return { kind: 'refused', reason: 'app must be a Fly app name' };
  }
  if (!apps.includes(app)) {
    return { kind: 'refused', reason: `${app} is not an app the keeper made or adopted` };
  }
  if (typeof board !== 'string' || !BOARD_ID.test(board)) {
    return { kind: 'refused', reason: 'board must be a board id' };
  }
  const named = Array.isArray(secrets) && secrets.length <= MAX_SECRETS;
  if (!named || !secrets.every((n) => typeof n === 'string' && SECRET_NAME.test(n))) {
    return { kind: 'refused', reason: `secrets must list at most ${MAX_SECRETS} secret names` };
  }
  return {
    kind: 'held',
    hold: 'move.grant',
    app,
    summary: `move board ${board} onto ${app}: the listed steps, for 30 minutes`,
  };
}

/** Whether a live grant covers this held request. */
export function grantCovers(
  grants: readonly Grant[],
  scope: 'fly' | 'cloudflare',
  verdict: Extract<Verdict, { kind: 'held' }>,
  cfPath: string | null,
  now: number,
): boolean {
  return grants.some((g) => {
    if (g.scope !== scope || g.expiresAt <= now) return false;
    if (scope === 'fly') {
      if (verdict.hold === 'project.create' || verdict.app !== g.target) return false;
      if (g.board === undefined) return verdict.setup === true;
      return moveSteps(g.board, g.secrets).some((step) => step.covers(verdict, g.target));
    }
    // A grant on an Access app covers writes to that app and its policies,
    // never a new app: that is a new `access.open` and a new tap.
    const pathname = (cfPath ?? '').split('?', 1)[0] ?? '';
    return (
      verdict.hold !== 'access.open' &&
      (pathname === g.target || pathname.startsWith(`${g.target}/`))
    );
  });
}
