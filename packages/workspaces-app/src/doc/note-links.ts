/**
 * The markdown links inside a `^[…]` note, split from the words around them.
 *
 * A note's body is opaque to the prose parser on purpose — the characters in
 * the file ARE the note (packages/core/src/footnotes.ts) — so a source written
 * as `[Planning report, table 4](docs/planning.md#table-4)` reached the margin
 * as that whole string, syntax and path included. This function is the other
 * half of the bargain: the file still holds exactly what the author typed, and
 * the three draws in `footnote-notes.ts` build `<a>` elements from what comes
 * back here, so the reader sees the label and clicks it.
 *
 * Pure, and the only place a note's href is judged. Two kinds may be followed:
 * an `http(s)` URL, and a link relative to the doc. Every other scheme —
 * `javascript:`, `data:`, `vbscript:`, and a protocol-relative `//host`, whose
 * scheme is whatever the page's happens to be — comes back as PLAIN TEXT
 * holding the characters the author wrote. Nothing unfollowable is turned into
 * a link, and nothing is silently dropped either: a reader who typed a bad
 * link can still see it well enough to fix it.
 */

/** One run of a note: plain words, or a link the renderer may draw as one. */
export interface NotePart {
  /** What the reader sees. */
  text: string;
  /** Where it goes. Absent on a plain run, and only then. */
  href?: string;
  /** An `http(s)` destination, which opens in a new tab. False for a relative
   *  href: that one names another doc in the same workspace, and following it
   *  keeps the reader in the review they are already in. */
  external?: boolean;
}

/**
 * Whether `href` may be followed, and how — or `null` for one that may not.
 *
 * The scheme is read with every character at or below U+0020 removed, because
 * a browser ignores embedded tabs, newlines and NULs when it resolves one:
 * `java\tscript:alert(1)` still executes. `safeLinkHref` in `link-open.ts`
 * guards the doc body's links the same way, from the other side — that one
 * refuses a denylist, this one admits an allowlist of two.
 */
export function noteLinkHref(href: string): { href: string; external: boolean } | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  let bare = '';
  for (const ch of trimmed) if (ch.charCodeAt(0) > 0x20) bare += ch;
  if (!bare) return null;
  if (/^https?:\/\//i.test(bare)) return { href: trimmed, external: true };
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare) || bare.startsWith('//')) return null;
  return { href: trimmed, external: false };
}

/**
 * Split `note` into the runs a renderer draws.
 *
 * Adjacent plain runs are merged, so a rejected link comes back joined to the
 * words around it rather than as a seam in the middle of a sentence.
 */
export function noteParts(note: string): NotePart[] {
  const out: NotePart[] = [];
  // An href holding a bracket or a space is not one: markdown asks for `<>`
  // or an escape there, and stopping at the first `(` is what keeps
  // `[a](javascript:alert(1))` from being read as a link in the first place —
  // `noteLinkHref` is the second answer to that, not the only one.
  const link = /\[([^\]]*)\]\(([^()\s]*)\)/g;
  let plain = '';
  let at = 0;
  const flush = (): void => {
    if (plain !== '') out.push({ text: plain });
    plain = '';
  };
  for (let m = link.exec(note); m !== null; m = link.exec(note)) {
    const raw = m[0];
    plain += note.slice(at, m.index);
    at = m.index + raw.length;
    const target = noteLinkHref(m[2] ?? '');
    // Backticks are markdown the note carries opaquely, and a label written as
    // `` [`plan.md`](…) `` is a link labelled plan.md — not one labelled with
    // two backticks the reader has to read past.
    const text = (m[1] ?? '').replaceAll('`', '').trim();
    if (!target || text === '') {
      plain += raw;
      continue;
    }
    flush();
    out.push({ text, href: target.href, external: target.external });
  }
  plain += note.slice(at);
  flush();
  return out;
}
