/**
 * Tell the board server which folders a walled lead can write
 * (`packages/server/src/board-socket-roots.ts`): the lead's projects and
 * every folder its config's `allow` opens to it for writing. The server then reads and writes
 * bound files under them only through its guard, and runs no git in a
 * repository holding one, so `lead-sandbox.ts` starts no walled lead
 * without the list.
 *
 * Sent from outside the wall, as the lead launches, to
 * `PUT /api/board-sockets/<board>/roots` on prod's port. That route answers
 * loopback callers only and refuses a request on a board socket, so the lead
 * itself cannot widen the list.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { BOARD_SERVER_PORTS } from './lead-sandbox-wall.ts';

/** Why the list was not stored, or null once the server holds it. */
export type RootsRegistrar = (boardId: string, roots: string[]) => string | null;

/**
 * The folders a lead can write, resolved, outermost first: its projects and
 * each `allow` entry that is a folder. One inside another is dropped, since
 * the server refuses nested roots and the outer one already holds it. An
 * `allow` entry that is a file is not a folder the server can hold.
 */
export function leadRoots(
  lead: { projects: string[]; allow: string[] },
  realpath: (p: string) => string,
  isDir: (p: string) => boolean = (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
): string[] {
  const all = [...lead.projects.map(realpath), ...lead.allow.filter(isDir).map(realpath)].sort(
    (a, b) => a.length - b.length,
  );
  const out: string[] = [];
  for (const p of all)
    if (!out.some((o) => p === o || p.startsWith(`${o}/`) || o === '/')) out.push(p);
  return out;
}

export function rootsUrl(boardId: string, port = BOARD_SERVER_PORTS[0]): string {
  return `http://127.0.0.1:${port}/api/board-sockets/${encodeURIComponent(boardId)}/roots`;
}

/** The real registrar: one `curl` PUT, bounded at five seconds. */
export const registerRootsWithCurl: RootsRegistrar = (boardId, roots) => {
  const r = spawnSync(
    '/usr/bin/curl',
    [
      '-sS',
      '--max-time',
      '5',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '-X',
      'PUT',
      '-H',
      'content-type: application/json',
      '--data-binary',
      JSON.stringify({ roots }),
      rootsUrl(boardId),
    ],
    { encoding: 'utf8' },
  );
  const status = r.stdout.trim();
  if (r.status === 0 && status === '200') return null;
  return status && status !== '000' ? `the server answered ${status}` : 'the server did not answer';
};
