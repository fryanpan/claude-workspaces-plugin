/**
 * How `workspace.app_unreachable` reads to the agent it wakes.
 *
 * The server sends it once per outage, when a reader's request to an attached
 * app finds nothing listening at its origin (`app-outage.ts` in the server).
 * The reader is the agent that attached the app, or the board's lead when the
 * attach recorded nobody. The next act is to start the dev server, so the line
 * names the origin it has to listen on and the address readers are opening.
 */

/** The fields this line reads off the frame. */
export interface AppUnreachablePayload {
  docId?: string;
  title?: string;
  origin?: string;
  prefix?: string;
  reason?: string;
  addressedAs?: 'attacher' | 'lead';
}

export function appUnreachableLine(p: AppUnreachablePayload): string {
  const app = p.title ? `"${p.title}" (${p.docId ?? '?'})` : (p.docId ?? 'an attached app');
  const why = p.reason ? ` (${p.reason})` : '';
  const whose =
    p.addressedAs === 'lead'
      ? ' You are told as the board lead: the attach recorded no agent, so pass this to whoever runs it.'
      : '';
  return `[workspace.app_unreachable] ${app} is not answering at ${p.origin ?? 'its origin'}${why}; readers opening ${p.prefix ?? 'it'} see "The app is not running". Start its dev server on that origin.${whose} This notice fires once per outage and re-arms after the app next answers.`;
}
