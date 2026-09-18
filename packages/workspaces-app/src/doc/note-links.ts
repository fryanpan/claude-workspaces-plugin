/**
 * The markdown links and code spans inside a `^[…]` note, split from the words
 * around them.
 *
 * A note's body is opaque to the prose parser on purpose — the characters in
 * the file ARE the note (packages/core/src/footnotes.ts) — so a source written
 * as `[Planning report, table 4](docs/planning.md#table-4)` reached the margin
 * as that whole string, syntax and path included. This function is the other
 * half of the bargain: the file still holds exactly what the author typed, and
 * the three draws in `footnote-notes.ts` build `<a>` elements from what comes
 * back here, so the reader sees the label and clicks it.
 *
 * A backtick span outside a link is the same bargain again. Fleet notes end
 * with a provenance tag the author writes in backticks — `` `[primary — read
 * 2026-09-18]` `` — and the tag stays inline in the markdown (owner's call,
 * 2026-09-05); what the renderer owes is a way to draw it that does not make
 * the reader read two backticks first. Those runs come back marked `code`, and
 * the syntax is the one thing dropped: the words between the backticks are
 * handed back whole. A backtick with no closer is not a span, so its
 * characters come back as the plain text they are.
 *
 * Pure, and the only place a note's href is judged. Two kinds may be followed:
 * an `http(s)` URL, and a link relative to the doc. Every other scheme —
 * `javascript:`, `data:`, `vbscript:`, and a protocol-relative `//host`, whose
 * scheme is whatever the page's happens to be — comes back as PLAIN TEXT
 * holding the characters the author wrote. Nothing unfollowable is turned into
 * a link, and nothing is silently dropped either: a reader who typed a bad
 * link can still see it well enough to fix it.
 */

/**
 * One run of a note: plain words, a link the renderer may draw as one, or a
 * backtick span the renderer draws quietly. Never both — a link's label is
 * already stripped of its backticks, so `href` and `code` do not meet.
 */
export interface NotePart {
  /** What the reader sees. Never the syntax around it. */
  text: string;
  /** Where it goes. Absent on a plain or code run, and only then. */
  href?: string;
  /** An `http(s)` destination, which opens in a new tab. False for a relative
   *  href: that one names another doc in the same workspace, and following it
   *  keeps the reader in the review they are already in. */
  external?: boolean;
  /** The author wrote these words between backticks. Present only when true,
   *  so a plain run stays the one-property object it has always been. */
  code?: true;
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
 * Push `text` as plain runs, with each closed backtick span split out as a
 * code run.
 *
 * A span needs a closer and at least one character between the pair: a lone
 * backtick, and an empty `` `` ``, are characters the author typed and come
 * back as themselves rather than as an element with nothing in it. The regex
 * is built per call, because a `g` regex carries its `lastIndex` between
 * calls and a shared one would start the second note where the first stopped.
 */
function pushPlain(out: NotePart[], text: string): void {
  if (text === '') return;
  const code = /`([^`]+)`/g;
  let at = 0;
  for (let m = code.exec(text); m !== null; m = code.exec(text)) {
    const before = text.slice(at, m.index);
    if (before !== '') out.push({ text: before });
    out.push({ text: m[1] ?? '', code: true });
    at = m.index + m[0].length;
  }
  const rest = text.slice(at);
  if (rest !== '') out.push({ text: rest });
}

/**
 * Split `note` into the runs a renderer draws.
 *
 * Adjacent plain runs are merged, so a rejected link comes back joined to the
 * words around it rather than as a seam in the middle of a sentence — and a
 * backtick span is looked for in the merged text, so a pair that opened before
 * a rejected link and closed after it is still one span.
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
    pushPlain(out, plain);
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
