/**
 * A board's AUDIENCE: the addresses and `@domain`s that may be in it at all.
 *
 * Bryan, 29 Oct: a share names who it is for, and only he changes that. The
 * audience is that list, kept on the board rather than on each link, so that
 * a forwarded link can only ever invite someone the board already names. It
 * is checked on every request (`ShareLinks.isMember`), so narrowing it ends a
 * person's access on their next one.
 *
 * Two entry shapes, read by `audienceEntryAdmits` like every other audience
 * on this server: `someone@partner.example` is one address and
 * `@partner.example` is every address at exactly that domain. A domain entry
 * can carry exceptions: removing one person a domain let in records them
 * there, so the domain does not let them straight back in. An exact entry
 * for that person beats the exception, which is how Bryan lets them back.
 *
 * No audience, or an empty one, admits nobody. A board that was shared before
 * audiences existed is given one by `seedAudiences`, from the people already
 * in, so nobody loses access on the upgrade.
 *
 * Pure functions over plain records; `share-links.ts` persists them.
 */
import { normalizeEmail } from '@claude-workspaces/core';
import { audienceEntryAdmits } from './shares.ts';

export interface AudienceEntry {
  /** An exact address or an `@domain`, lower-cased. */
  match: string;
  addedAt: number;
  /** Who added it, for the access page. Absent on a seeded entry. */
  addedBy?: string;
  /** On a domain entry: addresses removed from the board that it would
   *  otherwise admit. */
  except?: string[];
}

export interface BoardAudience {
  workspaceId: string;
  entries: AudienceEntry[];
}

const isDomain = (match: string): boolean => match.startsWith('@');

/** Does this board's audience admit this address? None admits nobody. */
export function boardAudienceAdmits(audience: BoardAudience | undefined, email: string): boolean {
  if (!audience) return false;
  const who = normalizeEmail(email);
  if (who === '') return false;
  return audience.entries.some((e) => {
    if (!isDomain(e.match)) return e.match === who;
    return audienceEntryAdmits(e.match, who) && !(e.except ?? []).includes(who);
  });
}

/**
 * The entries in `matches` this audience does not already admit — the part
 * of a request that would let someone new in. Empty means the request
 * widens nothing.
 */
export function entriesWidenAudience(
  audience: BoardAudience | undefined,
  matches: readonly string[],
): string[] {
  return matches.filter((m) => {
    if (isDomain(m)) return !audience?.entries.some((e) => e.match === m && !e.except?.length);
    return !boardAudienceAdmits(audience, m);
  });
}

/** Add entries, once each. Already-parsed by `parseShareAudience`. */
export function addAudienceEntries(
  audience: BoardAudience,
  matches: readonly string[],
  addedBy: string,
  at: number,
): BoardAudience {
  const entries = audience.entries.slice();
  for (const match of matches) {
    if (entries.some((e) => e.match === match)) continue;
    entries.push({ match, addedAt: at, addedBy });
  }
  return { workspaceId: audience.workspaceId, entries };
}

/**
 * Take someone, or a whole entry, out. An `@domain` names its entry, which
 * goes. An address drops its own exact entry, and every domain entry that
 * would still admit it records it as an exception.
 */
export function removeFromAudience(audience: BoardAudience, match: string): BoardAudience {
  const target = isDomain(match) ? match.toLowerCase() : normalizeEmail(match);
  if (isDomain(target)) {
    return {
      workspaceId: audience.workspaceId,
      entries: audience.entries.filter((e) => e.match !== target),
    };
  }
  const entries = audience.entries
    .filter((e) => e.match !== target)
    .map((e) =>
      isDomain(e.match) && audienceEntryAdmits(e.match, target) && !e.except?.includes(target)
        ? { ...e, except: [...(e.except ?? []), target] }
        : e,
    );
  return { workspaceId: audience.workspaceId, entries };
}

/** What the migration reads off a member row. */
export interface SeedMember {
  workspaceId: string;
  email: string;
  addedAt: number;
  viaLinkId: string;
}

/** What the migration reads off a link. */
export interface SeedLink {
  workspaceId: string;
  live: boolean;
  allowDomains?: string[];
}

/**
 * The audiences a registry written before audiences existed gets: each
 * board's current members by exact address, then the entries any live
 * link's own audience named, which Bryan chose when it was minted. Members
 * are passed already filtered to the ones their link still admits.
 */
export function seedAudiences(
  members: readonly SeedMember[],
  links: readonly SeedLink[],
  now: number,
): BoardAudience[] {
  const byBoard = new Map<string, AudienceEntry[]>();
  const add = (ws: string, match: string, addedAt: number): void => {
    const list = byBoard.get(ws) ?? [];
    if (!list.some((e) => e.match === match)) list.push({ match, addedAt });
    byBoard.set(ws, list);
  };
  for (const m of members) add(m.workspaceId, normalizeEmail(m.email), m.addedAt);
  for (const l of links) {
    if (!l.live) continue;
    for (const match of l.allowDomains ?? []) add(l.workspaceId, match, now);
  }
  return [...byBoard].map(([workspaceId, entries]) => ({ workspaceId, entries }));
}

/**
 * Read audiences off a stored registry. An entry that does not parse is
 * dropped, which can only narrow.
 */
export function storedAudiences(raw: unknown): BoardAudience[] {
  if (!Array.isArray(raw)) return [];
  const out: BoardAudience[] = [];
  for (const a of raw) {
    if (typeof a?.workspaceId !== 'string' || a.workspaceId === '') continue;
    const entries: AudienceEntry[] = [];
    for (const e of Array.isArray(a.entries) ? a.entries : []) {
      if (typeof e?.match !== 'string' || e.match === '' || e.match === '@') continue;
      const entry: AudienceEntry = {
        match: e.match.toLowerCase(),
        addedAt: typeof e.addedAt === 'number' ? e.addedAt : 0,
      };
      if (typeof e.addedBy === 'string') entry.addedBy = e.addedBy;
      if (Array.isArray(e.except)) {
        const except = e.except.filter((x: unknown): x is string => typeof x === 'string');
        if (except.length > 0) entry.except = except.map((x: string) => normalizeEmail(x));
      }
      entries.push(entry);
    }
    out.push({ workspaceId: a.workspaceId, entries });
  }
  return out;
}
