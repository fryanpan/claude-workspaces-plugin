/**
 * The rows "Who has access" draws, worked out from one read of
 * `GET /workspaces/<id>/members`: who, how they got in, what they may do, and
 * what Remove and the level control send. Drawing them is
 * `board-members.ts`; this is only the list, so it can be tested alone.
 */

import type { AccessRole } from './board-member-level.ts';

/** The two levels a board has. Wire values; `roleLabel` is what a person sees. */
export type BoardRole = 'owner' | 'member';

export interface BoardMemberEntry {
  email: string;
  role: BoardRole;
  /** When they first signed in. */
  addedAt?: number;
  /** The audience entry that admits them: their own address or an `@domain`. */
  entry?: string;
  /** The label of the link they came through, when it had one. */
  link?: string;
  /** What they may do, in the server's four words. */
  accessRole?: AccessRole;
}

/** One line of the board's audience. */
export interface BoardAudienceEntry {
  match: string;
  addedAt: number;
  addedBy?: string;
  /** On a `@domain`: what the people it lets in may do. Absent = edit. */
  access?: Exclude<AccessRole, 'owner'>;
}

/** What `GET /workspaces/<id>/members` answers, narrowed to what is drawn. */
export interface BoardMembersView {
  /** The reader. `email: null` is the operator on their own machine — an owner
   *  with no address, because none was ever proven and none is needed. */
  you: { email: string | null; role: BoardRole; accessRole?: AccessRole };
  members: BoardMemberEntry[];
  audience?: BoardAudienceEntry[];
  /** Access changes an agent proposed for this board, still unanswered. */
  openProposals?: number;
}

export const isDomain = (match: string): boolean => match.startsWith('@');

/** "9 Oct": the day is what a reader checks, never the time. */
export function shortDay(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** One row the list draws: who, how they got in, and what Remove takes out. */
export interface Row {
  key: string;
  title: string;
  meta: string;
  role?: BoardRole;
  /** What this person, or everyone this domain lets in, may do. */
  level?: AccessRole;
  /** What the level control sends; absent on your own row and on an address
   *  nobody has signed in with yet, which has no level to change. */
  setRole?: string;
  under: boolean;
  /** What Remove sends; absent on a row with no control (your own). */
  remove?: string;
  ask: string;
}

/** What removing a signed-in person does, said in the confirmation. */
const LOSES = 'They lose access at once, and any page they have open closes.';

function signedIn(m: BoardMemberEntry): string {
  const day = shortDay(m.addedAt);
  const when = day ? `Signed in ${day}` : 'Signed in';
  return m.link ? `${when} via link “${m.link}”` : when;
}

/** The rows in the order the mock draws them. */
export function accessRows(view: BoardMembersView): Row[] {
  const audience = view.audience ?? [];
  const yours = view.you.email;
  const rows: Row[] = [];
  const person = (m: BoardMemberEntry, under: boolean, meta: string, ask: string): Row => ({
    key: m.email,
    title: m.email === yours ? `${m.email} (you)` : m.email,
    meta,
    under,
    ask,
    ...(m.role === 'owner' ? { role: m.role } : {}),
    level: m.accessRole ?? (m.role === 'owner' ? 'owner' : 'edit'),
    ...(m.email === yours ? {} : { remove: m.email, setRole: m.email }),
  });
  const listed = new Set<string>();
  for (const e of audience.filter((x) => !isDomain(x.match))) {
    const m = view.members.find((p) => p.email === e.match);
    listed.add(e.match);
    if (m) {
      rows.push(person(m, false, signedIn(m), `Remove ${m.email}? ${LOSES}`));
    } else {
      rows.push({
        key: e.match,
        title: e.match,
        meta: `Added ${shortDay(e.addedAt)} · not signed in yet`,
        under: false,
        remove: e.match,
        ask: `Remove ${e.match}? They will not be able to sign in.`,
      });
    }
  }
  // A member the audience names no entry for: a board read before audiences
  // existed. Drawn as its own row, so nobody who can get in goes unlisted.
  for (const m of view.members) {
    if (listed.has(m.email) || (m.entry && isDomain(m.entry))) continue;
    listed.add(m.email);
    rows.push(person(m, false, m.addedAt ? signedIn(m) : '', `Remove ${m.email}? ${LOSES}`));
  }
  for (const e of audience.filter((x) => isDomain(x.match))) {
    const under = view.members.filter((m) => m.entry === e.match);
    const n = under.length;
    const count =
      n === 0 ? 'nobody signed in yet' : n === 1 ? '1 person signed in' : `${n} people signed in`;
    const losing =
      n === 0 ? '' : ` ${n} signed-in ${n === 1 ? 'person loses' : 'people lose'} access.`;
    rows.push({
      key: e.match,
      title: `Everyone at ${e.match}`,
      meta: `Added ${shortDay(e.addedAt)} · ${count}`,
      under: false,
      remove: e.match,
      level: e.access ?? 'edit',
      setRole: e.match,
      ask: `Stop letting in everyone at ${e.match}?${losing}`,
    });
    for (const m of under) {
      rows.push(
        person(
          m,
          true,
          signedIn(m),
          `Remove ${m.email}? ${LOSES} ${e.match} will not let them back in.`,
        ),
      );
    }
  }
  return rows;
}
