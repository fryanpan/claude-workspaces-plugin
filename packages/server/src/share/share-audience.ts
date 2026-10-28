/**
 * A share link's AUDIENCE: who may redeem it, and who it keeps admitting.
 *
 * Optional. A link minted without one admits whoever opens it and signs in,
 * which is what every link minted before this existed does, and those records
 * are read exactly as before. A link minted with one admits only the
 * addresses it names, and the check runs on every request a member makes, not
 * only at redemption — so an audience that stops naming someone ends their
 * access on their next request.
 *
 * Two entry shapes, the same two `accessPolicyRule` and `audienceEntryAdmits`
 * in `shares.ts` read: `someone@partner.example` is one address, and
 * `@partner.example` is every address at exactly that domain. Matching is
 * `audienceEntryAdmits`, so the share-link door and the collaboration door
 * cannot disagree about what an entry means. A subdomain is NOT the domain:
 * `@partner.example` does not admit `x@sub.partner.example`, and a lookalike
 * like `partner.example.evil.test` is a different domain altogether.
 *
 * The parser is stricter than the matcher on purpose. The matcher has to read
 * records already on disk; the parser decides what a new record may say, and
 * a permissive parse is how a typo becomes a board open to the wrong people.
 * So a bare `partner.example` (no `@`), a wildcard, whitespace, a second `@`
 * and an `@` with nothing after it are all refused rather than guessed at.
 */
import { audienceEntryAdmits } from './shares.ts';

/** More entries than any real invitation needs; bounds a hostile body. */
const MAX_ENTRIES = 200;
/** The longest address RFC 5321 allows through a mail path. */
const MAX_ENTRY_LENGTH = 254;
/** A local part: no whitespace, no `@`, no wildcard. */
const LOCAL_PART = /^[^\s@*?]+$/;
/** Dot-separated labels of letters, digits and inner hyphens; at least two. */
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export type ParsedAudience = { ok: true; audience: string[] } | { ok: false; hint: string };

const HINT =
  'allowDomains must be a non-empty array of addresses ("someone@partner.example") or domains ("@partner.example"). No wildcards, spaces, bare domains or second "@".';

/** One entry, lower-cased, or null when it is not one of the two shapes. */
function parseEntry(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_ENTRY_LENGTH) return null;
  const entry = raw.toLowerCase();
  const at = entry.indexOf('@');
  if (at < 0 || at !== entry.lastIndexOf('@')) return null;
  const local = entry.slice(0, at);
  if (local !== '' && !LOCAL_PART.test(local)) return null;
  return DOMAIN.test(entry.slice(at + 1)) ? entry : null;
}

/**
 * Validate an audience off a request body. Every entry must parse; one bad
 * entry refuses the whole list rather than minting a link narrower or wider
 * than the caller wrote. Duplicates collapse.
 */
export function parseShareAudience(raw: unknown): ParsedAudience {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ENTRIES) {
    return { ok: false, hint: HINT };
  }
  const out: string[] = [];
  for (const item of raw) {
    const entry = parseEntry(item);
    if (entry === null) return { ok: false, hint: `${HINT} Refused: ${JSON.stringify(item)}.` };
    if (!out.includes(entry)) out.push(entry);
  }
  return { ok: true, audience: out };
}

/**
 * Read an audience off a stored record. Absent is no audience. Anything else
 * that does not parse — a hand-edited file — reads as an EMPTY audience,
 * which admits nobody: failing closed loses a grant, failing open hands one
 * out.
 */
export function storedAudience(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseShareAudience(raw);
  return parsed.ok ? parsed.audience : [];
}

/** Does this audience admit this email? No audience admits everyone. */
export function audienceAdmits(audience: readonly string[] | undefined, email: string): boolean {
  if (audience === undefined) return true;
  return audience.some((entry) => audienceEntryAdmits(entry, email));
}
