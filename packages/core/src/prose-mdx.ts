/**
 * The MDX flow constructs a `.mdx` file adds to markdown, found line by line
 * so the markdown parser can hold each one as a single block.
 *
 * An `.mdx` post carries JSX components (`<LineChart data={[…]} />`), `{…}`
 * expressions (most often `{/* note *\/}`) and `import` / `export` lines. Read
 * as markdown they were paragraphs: a component spanning twenty lines became
 * one long run of raw text, and its line breaks existed only on disk.
 *
 * Each construct becomes a `codeBlock` whose language is `mdx-flow` and whose
 * text is the construct's source lines, exactly. Holding the source as text
 * rather than as attributes keeps three things for free: the serializer writes
 * the text back unchanged, a comment anchors to a range of it like any other
 * text, and a client that has never heard of MDX still renders it as a code
 * block rather than dropping a node it cannot name.
 *
 * Only a scan, never an evaluation: it tracks tags, braces, strings and
 * comments far enough to know where a construct ends, and gives up (returns
 * null, leaving the lines to the markdown grammar) on anything it cannot close.
 */

/** The `codeBlock` language an MDX flow construct is stored under. */
export const MDX_FLOW_LANGUAGE = 'mdx-flow';

/** Parse options. `mdx` turns on the flow constructs below. */
export interface MarkdownParseOptions {
  mdx?: boolean;
}

/** Whether a bound path is an MDX file, and so parses with `{ mdx: true }`. */
export function isMdxPath(path: string | undefined): boolean {
  return typeof path === 'string' && /\.mdx$/i.test(path);
}

const ESM = /^(?:import|export)(?=[\s{*])/;
const TAG_START = /^<(?:[A-Za-z]|>)/;

/**
 * If an MDX flow construct starts on `lines[start]`, the index of the line
 * after its last line; otherwise null. A construct must end at the end of a
 * line — `<Chart /> and more words` is inline JSX in a paragraph, which MDX
 * reads as prose and so do we.
 */
export function mdxFlowEnd(lines: string[], start: number): number | null {
  const first = lines[start] ?? '';
  if (ESM.test(first)) return esmEnd(lines, start);
  const lead = first.length - first.trimStart().length;
  if (lead > 3) return null;
  const text = lines.slice(start).join('\n');
  const at = lead;
  let end: number | null = null;
  if (text[at] === '{') end = skipBraces(text, at);
  else if (TAG_START.test(text.slice(at))) end = scanElement(text, at);
  if (end === null) return null;
  // The rest of the closing line must be blank.
  const nl = text.indexOf('\n', end);
  const rest = text.slice(end, nl === -1 ? text.length : nl);
  if (rest.trim() !== '') return null;
  let lineCount = 1;
  for (let c = 0; c < end; c++) if (text[c] === '\n') lineCount++;
  return start + lineCount;
}

/**
 * The line after an `import` / `export` run. MDX ends one at a blank line where
 * the code so far is a complete program, so a blank line inside a function
 * body or an object literal does not end it: brackets must be balanced and no
 * string, template or block comment open. A run that never balances ends at
 * its first blank line, which is what a stray bracket would otherwise cost.
 */
function esmEnd(lines: string[], start: number): number {
  let depth = 0;
  let mode: 'code' | 'block' | 'template' = 'code';
  let firstBlank: number | null = null;
  for (let k = start; k < lines.length; k++) {
    const line = lines[k] ?? '';
    if (k > start && line.trim() === '') {
      if (mode === 'code' && depth <= 0) return k;
      firstBlank ??= k;
      continue;
    }
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (mode === 'block') {
        if (ch === '*' && line[c + 1] === '/') {
          mode = 'code';
          c++;
        }
      } else if (mode === 'template') {
        if (ch === '\\') c++;
        else if (ch === '`') mode = 'code';
      } else if (ch === '/' && line[c + 1] === '*') {
        mode = 'block';
        c++;
      } else if (ch === '/' && line[c + 1] === '/') {
        break;
      } else if (ch === '"' || ch === "'") {
        const e = skipString(line, c);
        c = e === null ? line.length : e - 1;
      } else if (ch === '`') {
        mode = 'template';
      } else if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
      }
    }
  }
  return mode === 'code' && depth <= 0 ? lines.length : (firstBlank ?? lines.length);
}

/** Index just past the `}` matching the `{` at `at`, or null. */
function skipBraces(s: string, at: number): number | null {
  let depth = 0;
  let k = at;
  while (k < s.length) {
    const ch = s[k];
    if (ch === '"' || ch === "'" || ch === '`') {
      const e = skipString(s, k);
      if (e === null) return null;
      k = e;
      continue;
    }
    if (ch === '/' && s[k + 1] === '*') {
      const e = s.indexOf('*/', k + 2);
      if (e === -1) return null;
      k = e + 2;
      continue;
    }
    if (ch === '/' && s[k + 1] === '/') {
      const e = s.indexOf('\n', k);
      if (e === -1) return null;
      k = e;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return k + 1;
    }
    k++;
  }
  return null;
}

/** Index just past the closing quote of the string opening at `at`. */
function skipString(s: string, at: number): number | null {
  const q = s[at];
  let k = at + 1;
  while (k < s.length) {
    const ch = s[k];
    if (ch === '\\') {
      k += 2;
      continue;
    }
    if (ch === q) return k + 1;
    // A quoted attribute may span lines; a JS string may not, but a template
    // literal may. Only a stray quote runs to the end of the text.
    k++;
  }
  return null;
}

/**
 * Index just past the element opening at `at` (`<Name …>…</Name>`, `<Name />`
 * or a `<>…</>` fragment), or null if it never closes. Children are scanned
 * for nested tags and `{…}` only; their prose is not read.
 */
function scanElement(s: string, at: number): number | null {
  let depth = 0;
  let k = at;
  while (k < s.length) {
    const ch = s[k];
    if (ch === '{') {
      const e = skipBraces(s, k);
      if (e === null) return null;
      k = e;
      continue;
    }
    if (ch === '<' && s[k + 1] === '/') {
      const e = s.indexOf('>', k);
      if (e === -1) return null;
      depth--;
      k = e + 1;
      if (depth <= 0) return depth === 0 ? k : null;
      continue;
    }
    if (ch === '<' && /[A-Za-z>]/.test(s[k + 1] ?? '')) {
      const e = scanOpenTag(s, k);
      if (e === null) return null;
      k = e.end;
      if (!e.selfClosing) depth++;
      else if (depth === 0) return k;
      continue;
    }
    k++;
  }
  return null;
}

/** The end of the opening tag at `at`, and whether it closed itself. */
function scanOpenTag(s: string, at: number): { end: number; selfClosing: boolean } | null {
  let k = at + 1;
  while (k < s.length) {
    const ch = s[k];
    if (ch === '"' || ch === "'") {
      const e = skipString(s, k);
      if (e === null) return null;
      k = e;
      continue;
    }
    if (ch === '{') {
      const e = skipBraces(s, k);
      if (e === null) return null;
      k = e;
      continue;
    }
    if (ch === '/' && s[k + 1] === '>') return { end: k + 2, selfClosing: true };
    if (ch === '>') return { end: k + 1, selfClosing: false };
    k++;
  }
  return null;
}
