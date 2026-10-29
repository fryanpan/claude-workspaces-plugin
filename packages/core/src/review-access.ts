/**
 * An ACCESS change an agent proposed and only Bryan can apply: the payload an
 * `access` review item carries, and the words both the card and the access
 * page show for it.
 *
 * Bryan, 29 Oct: only he changes who is in. An agent's call that would let
 * somebody new in — a new address or domain, a promotion, a link for people
 * the board does not name yet — files one of these instead of changing
 * anything, and his Approve in the browser applies exactly this payload. The
 * words a reader approves are derived from it here (`accessChangeLine`), not
 * taken from the filer, so a reworded headline cannot describe one change
 * while the payload makes another.
 *
 * A subpath export rather than part of the index, so the widget bundle, which
 * never renders one, does not carry it.
 */

export type AccessRole = 'owner' | 'member';

/** What a proposed link will be minted with. */
export interface AccessLinkRequest {
  label?: string;
  ttlSeconds?: number;
  role?: AccessRole;
  landing?: { kind: string; id?: string };
  allowDomains?: string[];
}

export type ReviewAccessChange =
  /** Let these addresses or `@domain`s into the board. */
  | { op: 'add-audience'; workspaceId: string; entries: string[] }
  /** Change what one member may do. */
  | { op: 'set-role'; workspaceId: string; email: string; role: AccessRole; before: AccessRole }
  /** Name `entries` in the audience (possibly none), then mint a link. */
  | { op: 'share-link'; workspaceId: string; entries: string[]; link: AccessLinkRequest }
  /** Turn this board's sharing back on after it was closed. */
  | { op: 'open-board'; workspaceId: string }
  /** Clear this board's never-shareable lock. */
  | { op: 'unlock-board'; workspaceId: string };

const ROLE_WORD: Record<AccessRole, string> = { owner: 'Owner', member: 'Regular User' };

function entryWords(entries: readonly string[]): string {
  return entries.map((e) => (e.startsWith('@') ? `everyone at ${e}` : e)).join(', ');
}

/** Longest label a card quotes. */
export const ACCESS_LABEL_MAX = 60;

/**
 * A label as a card quotes it: no control characters or quote marks, so it
 * cannot close its own quotes and add words of its own, and capped.
 */
export function quotedLabel(label: string): string {
  const clean = label
    .replace(/[\p{Cc}"“”'‘’`]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > ACCESS_LABEL_MAX ? `${clean.slice(0, ACCESS_LABEL_MAX - 1)}…` : clean;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "3 days", "2 hours", "45 minutes": the largest whole unit. */
export function ttlWords(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0) return plural(seconds / 86_400, 'day');
  if (seconds >= 3_600 && seconds % 3_600 === 0) return plural(seconds / 3_600, 'hour');
  return plural(Math.max(1, Math.round(seconds / 60)), 'minute');
}

const LANDING_WORD: Record<string, string> = {
  home: "the board's Home",
  board: 'the board',
  task: 'a task',
  doc: 'a doc',
  mockup: 'a mock',
  app: 'a dev server',
};

/** One plain sentence saying what approving does. */
export function accessChangeLine(change: ReviewAccessChange): string {
  switch (change.op) {
    case 'add-audience':
      return `Lets ${entryWords(change.entries)} sign in to this board.`;
    case 'set-role':
      return `Makes ${change.email} ${ROLE_WORD[change.role]} (now ${ROLE_WORD[change.before]}).`;
    case 'share-link': {
      const { link } = change;
      const who =
        change.entries.length > 0
          ? `Lets ${entryWords(change.entries)} sign in, and mints`
          : 'Mints';
      const label = link.label ? quotedLabel(link.label) : '';
      const head = `${who} a share link${label ? ` "${label}"` : ''}${link.role === 'owner' ? ' that makes everyone who opens it an Owner' : ''}`;
      const parts = [
        head,
        link.ttlSeconds !== undefined
          ? `open for ${ttlWords(link.ttlSeconds)}`
          : 'open until it is revoked',
        link.landing
          ? `opening on ${LANDING_WORD[link.landing.kind] ?? 'one thing on the board'}${link.landing.id ? ` (${link.landing.id})` : ''}`
          : '',
      ].filter((p) => p !== '');
      return `${parts.join(', ')}.`;
    }
    case 'open-board':
      return 'Turns sharing back on for this board, so the people it names can sign in again.';
    case 'unlock-board':
      return 'Unlocks this board, so it can be shared again.';
  }
}

/** Keys in a fixed order, so two equal payloads serialize alike. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Is what the browser was showing exactly the change stored? */
export function sameAccessChange(shown: unknown, stored: ReviewAccessChange): boolean {
  return canonical(shown) === canonical(stored);
}

const isRole = (v: unknown): v is AccessRole => v === 'owner' || v === 'member';
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Read one back defensively; anything malformed is no change at all. */
export function readAccessChange(raw: unknown): ReviewAccessChange | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.workspaceId !== 'string' || r.workspaceId === '') return undefined;
  const workspaceId = r.workspaceId;
  if (r.op === 'add-audience' && isStrings(r.entries) && r.entries.length > 0) {
    return { op: 'add-audience', workspaceId, entries: r.entries };
  }
  if (r.op === 'set-role' && typeof r.email === 'string' && isRole(r.role) && isRole(r.before)) {
    return { op: 'set-role', workspaceId, email: r.email, role: r.role, before: r.before };
  }
  if (r.op === 'open-board' || r.op === 'unlock-board') return { op: r.op, workspaceId };
  if (r.op === 'share-link' && isStrings(r.entries) && r.link && typeof r.link === 'object') {
    const l = r.link as Record<string, unknown>;
    const link: AccessLinkRequest = {};
    if (typeof l.label === 'string') link.label = l.label;
    if (typeof l.ttlSeconds === 'number' && Number.isFinite(l.ttlSeconds)) {
      link.ttlSeconds = l.ttlSeconds;
    }
    if (isRole(l.role)) link.role = l.role;
    if (isStrings(l.allowDomains)) link.allowDomains = l.allowDomains;
    const landing = l.landing as Record<string, unknown> | undefined;
    if (landing && typeof landing.kind === 'string') {
      link.landing = {
        kind: landing.kind,
        ...(typeof landing.id === 'string' ? { id: landing.id } : {}),
      };
    }
    return { op: 'share-link', workspaceId, entries: r.entries, link };
  }
  return undefined;
}
