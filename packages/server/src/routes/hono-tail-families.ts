/**
 * ── The tail: what the board app tries after every board family (M12) ──
 *
 * What used to be `request-chain-tail.ts`, in its order: the git-push feature
 * (`features.ts`), the shell and static serving, the task address, board
 * links in the wrong form, the stale-client 410, the wrong-prefix hint and
 * the board's own not-found page. `server.ts` registers these on the board
 * app after `honoBoardFamilies`, so each is still tried after every board
 * family and after everything above it here, exactly as in the chain.
 *
 * Every family claims `*`. Each of these handlers decides from the path
 * itself and was written to be tried on any address that got this far; the
 * shell in particular answers paths no pattern list could name. So their
 * order of registration is the only thing that orders them, and that order
 * is the chain's. An address all of them decline is Hono's miss, and the
 * chain answers it with the bare 404 it always ended on.
 */
import type { Context } from 'hono';
import type { FeatureRoutes } from '../feature-module.ts';
import type { HonoBoardAppEnv, HonoBoardFamily } from '../hono-env.ts';
import { type BoardLinkRoutesContext, handleBoardLinkRoutes } from './board-links.ts';
import { type HonoFamiliesContext, chainValues, claimWith } from './hono-families.ts';
import type { ShellStatic } from './shell-static.ts';
import { handleStaleClient } from './stale-client.ts';
import { handleTaskPageRoutes } from './task-page.ts';
import { handleWorkspaceNotFound } from './workspace-not-found.ts';
import { handleWrongPrefix } from './wrong-prefix.ts';

/** Everything long-lived the tail reads. Built once by `server.ts`. */
export interface HonoTailFamiliesContext
  extends Pick<HonoFamiliesContext, 'requireSignInToWrite' | 'policyFor'> {
  /** Every registered feature's routes (`features.ts`). Git push alone is
   *  still registered there; it claims `/workspaces/<board>/git/`. */
  featureRoutes: FeatureRoutes;
  serveShellRoutes: ShellStatic['serveShellRoutes'];
  /** The wrong-form board links and the relative-link open route. */
  boardLinkRoutesCtx: BoardLinkRoutesContext;
}

/** The per-request values the tail read, off `c.env`. */
function tailValues(c: Context<HonoBoardAppEnv>, ctx: HonoTailFamiliesContext) {
  const { gate, mayMintAppVoice } = c.env;
  return { ...chainValues(c, ctx), gate, mayMintAppVoice };
}

type TailValues = ReturnType<typeof tailValues>;
type Answer = Response | null | undefined;

/** Every address that got this far. */
const ANY = ['*'];

export function honoTailFamilies(ctx: HonoTailFamiliesContext): HonoBoardFamily[] {
  const claim =
    (answer: (v: TailValues) => Answer | Promise<Answer>): HonoBoardFamily =>
    (app) =>
      claimWith(app, (c) => tailValues(c, ctx), ANY, answer);
  return [
    // The registered features still routed here — git push alone.
    claim((v) =>
      ctx.featureRoutes({
        req: v.req,
        pathname: v.pathname,
        visitor: v.visitor,
        ownerProven: v.ownerProven,
        requestOrigin: v.requestOrigin,
      }),
    ),
    // routes/shell-static.ts — an HTML shell, a built asset, a mockup's own
    // file, or a redirect to the address that has one.
    claim((v) =>
      ctx.serveShellRoutes({
        req: v.req,
        url: v.url,
        pathname: v.pathname,
        visitor: v.visitor,
        visitorHome: v.gate.visitorHome,
        ownerProven: v.ownerProven(),
        isBoardOwner: (workspaceId) => v.gate.requireOwner(workspaceId) === null,
        mayMintAppVoice: v.mayMintAppVoice(),
      }),
    ),
    // routes/task-page.ts — below the shell because it answers no page of
    // its own, and below every task route so it shadows none of them: what
    // reaches here is the BARE `/workspaces/<ws>/tasks/<taskId>`, which it
    // redirects to the board with that task open.
    claim((v) => handleTaskPageRoutes({ method: v.req.method, pathname: v.pathname, url: v.url })),
    // routes/board-links.ts — `review/<id>`, an escaped `?` and
    // `open?path=`, each redirected to the page it names.
    claim((v) =>
      handleBoardLinkRoutes(ctx.boardLinkRoutesCtx, {
        method: v.req.method,
        pathname: v.pathname,
        url: v.url,
      }),
    ),
    // routes/stale-client.ts — above the wrong-prefix hint and below
    // everything that exists: an address the pre-cutover client used is told
    // the client is behind.
    claim((v) => handleStaleClient(v.pathname)),
    // routes/wrong-prefix.ts — a guess at a board route with `/api` in
    // front is told the address without it.
    claim((v) => handleWrongPrefix(v.pathname)),
    // routes/workspace-not-found.ts — the last thing tried, so it shadows
    // nothing: a browser asking for an address under a board nothing serves
    // gets a page linking back to the board rather than a bodyless 404.
    claim((v) =>
      handleWorkspaceNotFound({ pathname: v.pathname, method: v.req.method, url: v.url }),
    ),
  ];
}
