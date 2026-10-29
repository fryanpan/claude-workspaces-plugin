/**
 * What the "Add someone" box accepts: one exact address or one `@domain`,
 * and, for anything else, a sentence that says how to fix it. Used by the
 * board's Settings and the access page through `board-members.ts`.
 */

/** A typed address or `@domain`, lower-cased, or null for anything else. */
export function readAccessMatch(raw: string): string | null {
  const m = raw.trim().toLowerCase();
  if (/^@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(m)) return m;
  if (/^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(m)) return m;
  return null;
}

/** Why a typed entry is not an address or a domain, in words that say the fix. */
export function accessMatchProblem(raw: string): string {
  const m = raw.trim();
  if (m === '') return 'Type an address (name@company.com) or a domain starting with @.';
  if (/\s/.test(m)) return 'Take out the spaces: one address or one domain at a time.';
  if (!m.includes('@'))
    return `Add an @: ${m}@company.com for one person, @${m} for everyone there.`;
  if ((m.match(/@/g) ?? []).length > 1) return 'Use one @: name@company.com, or @company.com.';
  const domain = m.slice(m.indexOf('@') + 1);
  if (domain === '') return 'Add the company after the @, like name@company.com.';
  if (!domain.includes('.')) return `Add the ending after ${domain}, like @${domain}.com.`;
  return 'That is not an address or a domain. Use name@company.com, or @company.com.';
}
