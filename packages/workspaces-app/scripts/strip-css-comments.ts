/**
 * The served stylesheets without their comments.
 *
 * The stylesheets carry their reasoning as comments, and that is most of
 * their bytes: measured 20 Oct 2026, `doc.css` was 59 KB gzipped as written
 * and 16 KB without comments, `board.css` 81 KB and 16 KB. Every byte of a
 * stylesheet in the head is on the path to the first paint.
 *
 * Only comments and blank or indenting whitespace go. Rules, their order and
 * every value stay byte for byte, so the cascade a test reads off the source
 * is the cascade the browser gets — which a minifier that merges or reorders
 * rules would not promise. Quoted strings are copied whole, so a `/*` inside
 * a `url("…")` or a `content: "…"` is kept.
 */
export function stripCssComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      out += css.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  const lines = out.split('\n').map((l) => l.trim());
  return `${lines.filter((l) => l !== '').join('\n')}\n`;
}
