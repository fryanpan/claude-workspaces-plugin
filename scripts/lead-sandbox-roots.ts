/**
 * Tell the board server which folders a walled lead may bind onto its board
 * (`packages/server/src/board-socket-roots.ts`): the lead's projects, the
 * folders its profile already opens to it. Without the list the server
 * refuses every folder bind the lead asks for over its socket.
 *
 * Sent from outside the wall, as the lead launches, to
 * `PUT /api/board-sockets/<board>/roots` on prod's port. That route answers
 * loopback callers only and refuses a request on a board socket, so the lead
 * itself cannot widen the list.
 */
import { spawnSync } from 'node:child_process';
import { BOARD_SERVER_PORTS } from './lead-sandbox-wall.ts';

/** Why the list was not stored, or null once the server holds it. */
export type RootsRegistrar = (boardId: string, roots: string[]) => string | null;

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
