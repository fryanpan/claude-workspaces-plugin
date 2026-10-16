/**
 * Types for the plain-JS Worker, for the server tests that drive it. The
 * Worker itself ships as worker.js — Cloudflare never sees this file.
 */
export type BoardRoute =
  | { kind: 'forward'; boardId: string; origin: string }
  | { kind: 'not_found' };

export type Upstream = (
  request: Request,
  init: { redirect: 'manual'; cf: { resolveOverride: string } },
) => Promise<Response>;

export function parseBoardOrigins(raw: unknown): Map<string, string> | null;
export function boardIdOfPath(pathname: string): string | null;
export function routeBoardRequest(
  url: URL,
  referer: string | null,
  table: Map<string, string> | null,
): BoardRoute;
export function handleBoardRequest(
  request: Request,
  env: { BOARD_ORIGINS?: string } | undefined,
  upstream?: Upstream,
): Promise<Response>;

declare const handler: {
  fetch(request: Request, env: { BOARD_ORIGINS?: string }): Promise<Response>;
};
export default handler;
