/**
 * Types for the plain-JS Worker, for the server tests that drive it. The
 * Worker itself ships as worker.js — Cloudflare never sees this file.
 */
export type BoardRoute =
  | { kind: 'forward'; boardId: string; origin: string }
  | { kind: 'not_found' };

export type Route = BoardRoute | { kind: 'forward'; project: string; origin: string };

export interface RouterEnv {
  BOARD_ORIGINS?: string;
  PROJECT_ORIGINS?: string;
  ONE_ADDRESS?: string;
}

export type Upstream = (
  request: Request,
  init: { redirect: 'manual'; cf: { resolveOverride: string } },
) => Promise<Response>;

export function parseBoardOrigins(raw: unknown): Map<string, string> | null;
export function parseProjectOrigins(raw: unknown): Map<string, string> | null;
export function boardIdOfPath(pathname: string): string | null;
export function projectOfHost(hostname: string, oneAddress: string): string | null;
export function keptCookies(header: string | null): string | null;
export function setsDomainCookie(setCookie: string): boolean;
export function withoutDomainCookies(response: Response): Response;
export function routeBoardRequest(
  url: URL,
  referer: string | null,
  table: Map<string, string> | null,
): BoardRoute;
export function routeRequest(url: URL, referer: string | null, env: RouterEnv | undefined): Route;
export function handleBoardRequest(
  request: Request,
  env: RouterEnv | undefined,
  upstream?: Upstream,
): Promise<Response>;

declare const handler: {
  fetch(request: Request, env: RouterEnv): Promise<Response>;
};
export default handler;
