/**
 * The props of a JSX opening tag in an `.mdx` doc, read as literals by one
 * parser that both sides use: the page, to draw a component's preview
 * (`workspaces-app/src/mdx-preview.ts`), and the server, to decide which data
 * file a `<StreetMap src>` lets a visitor read (`map-spec.ts`, called from
 * `server/src/doc-file-scope.ts`). One reader, so a tag the page draws from a
 * file is a tag the server serves that file for, and no other.
 *
 * The source is somebody's document text, so nothing here runs it. Values are
 * numbers, strings, booleans, null, arrays and plain objects; anything else (a
 * variable, a call, a spread) is `UNREADABLE`. A bare attribute is `true`.
 */

/** A prop whose value is not a literal: a variable, a call, a spread. */
export const UNREADABLE: unique symbol = Symbol('unreadable');

export interface OpenTag {
  /** The tag's name (`StreetMap`, `Foo.Bar`), or '' for a fragment `<>`. */
  name: string;
  /** Literal props by name; a prop the reader could not read is `UNREADABLE`.
   *  Empty when the tag is not closed. */
  props: Map<string, unknown>;
  /** Index in the source just past the tag's `>` or `/>`, or -1 when a
   *  quote, a brace or the `>` is missing. */
  end: number;
}

/** The opening tag that starts at `s[at]` (a `<`). */
export function readOpenTag(s: string, at = 0): OpenTag {
  const end = openTagEnd(s, at);
  const props = new Map<string, unknown>();
  const r = new Reader(end < 0 ? s : s.slice(0, end), at + 1);
  const raw = r.ident();
  const name = /^[A-Za-z]/.test(raw) ? raw : '';
  if (end < 0) return { name, props, end };
  for (;;) {
    r.ws();
    const key = r.ident();
    if (!key) break;
    r.ws();
    // A bare attribute is JSX's `true`.
    if (r.s[r.i] !== '=') {
      props.set(key, true);
      continue;
    }
    r.i++;
    r.ws();
    if (r.s[r.i] === '"' || r.s[r.i] === "'") {
      const v = r.string();
      if (v === undefined) break;
      props.set(key, v);
    } else if (r.s[r.i] === '{') {
      const start = r.i;
      r.i++;
      const v = r.value();
      r.ws();
      if (v !== NOT_LITERAL && r.s[r.i] === '}') {
        props.set(key, v);
        r.i++;
      } else {
        // Kept as unreadable, so a chart can say which prop it could not draw.
        props.set(key, UNREADABLE);
        r.i = start;
        if (!r.skipBraces()) break;
      }
    } else break;
  }
  return { name, props, end };
}

/** Index just past the `>` of the opening tag starting at `s[at]`, or -1. */
function openTagEnd(s: string, at: number): number {
  const r = new Reader(s, at + 1);
  while (r.i < s.length) {
    const ch = s[r.i];
    if (ch === '"' || ch === "'") {
      if (r.string() === undefined) return -1;
    } else if (ch === '{') {
      if (!r.skipBraces()) return -1;
    } else if (ch === '>') return r.i + 1;
    else r.i++;
  }
  return -1;
}

const NOT_LITERAL = Symbol('not-literal');
const MAX_DEPTH = 8;
const MAX_ITEMS = 5000;

/** A cursor over JS literal syntax. Reads values; never evaluates. */
class Reader {
  constructor(
    readonly s: string,
    public i = 0,
  ) {}

  ws(): void {
    for (;;) {
      const m = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(this.s.slice(this.i));
      if (!m) return;
      this.i += m[0].length;
    }
  }

  ident(): string {
    const m = /^[A-Za-z_$][\w$.:-]*/.exec(this.s.slice(this.i));
    if (!m) return '';
    this.i += m[0].length;
    return m[0];
  }

  string(): string | undefined {
    const q = this.s[this.i];
    let out = '';
    let k = this.i + 1;
    while (k < this.s.length) {
      const ch = this.s[k];
      if (ch === '\\') {
        out += this.s[k + 1] ?? '';
        k += 2;
        continue;
      }
      if (ch === q) {
        this.i = k + 1;
        return out;
      }
      out += ch;
      k++;
    }
    return undefined;
  }

  skipBraces(): boolean {
    let depth = 0;
    while (this.i < this.s.length) {
      const ch = this.s[this.i];
      if (ch === '"' || ch === "'" || ch === '`') {
        if (this.string() === undefined) return false;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        this.i++;
        return true;
      }
      this.i++;
    }
    return false;
  }

  value(depth = 0): unknown {
    if (depth > MAX_DEPTH) return NOT_LITERAL;
    this.ws();
    const ch = this.s[this.i];
    if (ch === '"' || ch === "'") return this.string() ?? NOT_LITERAL;
    if (ch === '[') return this.array(depth);
    if (ch === '{') return this.object(depth);
    const num = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.s.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return Number(num[0]);
    }
    for (const [word, v] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.s.startsWith(word, this.i) && !/[\w$]/.test(this.s[this.i + word.length] ?? '')) {
        this.i += word.length;
        return v;
      }
    }
    return NOT_LITERAL;
  }

  private array(depth: number): unknown {
    this.i++;
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') {
        this.i++;
        return out;
      }
      if (out.length >= MAX_ITEMS) return NOT_LITERAL;
      const v = this.value(depth + 1);
      if (v === NOT_LITERAL) return NOT_LITERAL;
      out.push(v);
      this.ws();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== ']') return NOT_LITERAL;
    }
  }

  private object(depth: number): unknown {
    this.i++;
    // A null prototype: a key named `__proto__` is just a key.
    const out: Record<string, unknown> = Object.create(null);
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') {
        this.i++;
        return out;
      }
      const ch = this.s[this.i];
      // A bare key is a name or a number: `{ 1: "Jan" }` keys on "1".
      const bare =
        ch === '"' || ch === "'"
          ? undefined
          : /^(?:[A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/.exec(this.s.slice(this.i))?.[0];
      const key =
        bare === undefined ? this.string() : /^\d/.test(bare) ? String(Number(bare)) : bare;
      if (key === undefined) return NOT_LITERAL;
      if (bare !== undefined) this.i += bare.length;
      this.ws();
      if (this.s[this.i] !== ':') return NOT_LITERAL;
      this.i++;
      const v = this.value(depth + 1);
      if (v === NOT_LITERAL) return NOT_LITERAL;
      out[key] = v;
      this.ws();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== '}') return NOT_LITERAL;
    }
  }
}
