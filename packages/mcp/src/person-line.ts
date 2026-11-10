/**
 * The channel line for `person.landed`: the board owner's attended tab
 * arrived on a page (`packages/server/src/person-presence.ts`). It names the
 * person, the page — a doc, diff, mock, app, whiteboard, task or goal by kind,
 * id and title, any other board page by its path — and the place in view, so
 * the agent can answer about what they are looking at without asking.
 */

export interface PersonLandedLike {
  person?: { name?: string };
  resource?: { kind?: string; id?: string; title?: string };
  spot?: {
    path?: string;
    threadId?: string;
    blockId?: string;
    quote?: string;
    scroll?: number;
  };
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function personLandedLine(p: PersonLandedLike): string {
  const who = p.person?.name || 'The owner';
  const r = p.resource ?? {};
  const title = r.title ? ` "${clip(r.title, 80)}"` : '';
  const page =
    r.kind && r.kind !== 'page' && r.id
      ? `${r.kind} ${r.id}${title}`
      : `page ${p.spot?.path ?? 'of the board'}`;
  const s = p.spot ?? {};
  const at: string[] = [];
  if (s.threadId) at.push(`thread ${s.threadId}`);
  if (s.blockId) at.push(`block ${s.blockId}`);
  if (s.quote) at.push(`"${clip(s.quote, 120)}"`);
  if (at.length === 0 && typeof s.scroll === 'number')
    at.push(`${Math.round(s.scroll * 100)}% down`);
  const place = at.length > 0 ? `, at ${at.join(', ')}` : '';
  return `[person.landed] ${who} is now on ${page}${place}. show_person takes them somewhere; point_at only moves followers.`;
}

const DOC_KINDS = new Set(['doc', 'diff', 'mockup', 'app', 'whiteboard']);

/** The page's id under the name the channel meta carries it. */
export function personLandedIds(p: PersonLandedLike): { docId?: string; taskId?: string } {
  const r = p.resource;
  if (!r?.id || !r.kind) return {};
  if (DOC_KINDS.has(r.kind)) return { docId: r.id };
  if (r.kind === 'task') return { taskId: r.id };
  return {};
}
