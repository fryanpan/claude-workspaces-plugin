/**
 * What an `.mdx` block shows in place of its source: the component's name and
 * `title`, a plain line for a chart whose points are written out, a muted line
 * for a comment or the imports.
 *
 * The source is somebody's document text, so nothing here runs it. Props are
 * read by a literal parser that knows numbers, strings, booleans, null, arrays
 * and plain objects, and returns undefined for anything else — a variable, a
 * call, a spread. Every string reaches the DOM through `textContent`.
 */

export type MdxKind = 'esm' | 'expr' | 'jsx';

export interface MdxSummary {
  kind: MdxKind;
  /** The line shown: a component's name, a comment's words, the imports. */
  label: string;
  /** A component's `title` prop, when it is a string literal. */
  title?: string;
  /** Points to draw, when `data` (or a series' `data`) is a literal x/y list. */
  points?: Array<{ x: number; y: number }>;
  /** A component's children as plain words, tags removed. */
  children?: string;
}

export function summarizeMdx(source: string): MdxSummary {
  const text = source.trim();
  if (/^(?:import|export)\b/.test(text)) {
    const names = [...text.matchAll(/^import\s+(.+?)\s+from\b/gm)].flatMap((m) =>
      (m[1] ?? '')
        .replace(/[{}*]/g, ' ')
        .split(/[\s,]+/)
        .filter(isImportName),
    );
    return {
      kind: 'esm',
      label: names.length > 0 ? `import ${names.join(', ')}` : (text.split('\n')[0] ?? ''),
    };
  }
  if (text.startsWith('{')) {
    const comment = text.match(/^\{\s*\/\*([\s\S]*?)\*\/\s*\}$/);
    return { kind: 'expr', label: (comment?.[1] ?? text).trim() };
  }
  const name = text.match(/^<([A-Za-z][\w.:-]*)?/)?.[1] ?? 'Fragment';
  const summary: MdxSummary = { kind: 'jsx', label: name };
  const props = readProps(text);
  const title = props.get('title');
  if (typeof title === 'string') summary.title = title;
  const points = pointsOf(props.get('data')) ?? seriesPoints(props.get('series'));
  if (points) summary.points = points;
  const close = text.lastIndexOf(`</${name === 'Fragment' ? '' : name}>`);
  const openEnd = openTagEnd(text);
  if (close > 0 && openEnd > 0 && close > openEnd) {
    const words = text
      .slice(openEnd, close)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (words) summary.children = words;
  }
  return summary;
}

function isImportName(s: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(s) && s !== 'as' && s !== 'type';
}

function pointsOf(value: unknown): Array<{ x: number; y: number }> | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const out: Array<{ x: number; y: number }> = [];
  for (const p of value) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined;
    const { x, y } = p as Record<string, unknown>;
    if (typeof x !== 'number' || typeof y !== 'number') return undefined;
    out.push({ x, y });
  }
  return out;
}

function seriesPoints(value: unknown): Array<{ x: number; y: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const s of value) {
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      const pts = pointsOf((s as Record<string, unknown>).data);
      if (pts) return pts;
    }
  }
  return undefined;
}

// ---- the opening tag's props ------------------------------------------------

/** Index just past the opening tag's `>` or `/>`, or -1. */
function openTagEnd(s: string): number {
  const r = new Reader(s, 1);
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

/** `name="x"` and `name={literal}` props; a prop whose value is not a literal is absent. */
function readProps(s: string): Map<string, unknown> {
  const props = new Map<string, unknown>();
  const end = openTagEnd(s);
  if (end < 0) return props;
  const r = new Reader(s.slice(0, end), 1);
  r.ident(); // the tag name
  for (;;) {
    r.ws();
    const key = r.ident();
    if (!key) break;
    r.ws();
    if (s[r.i] !== '=') continue;
    r.i++;
    r.ws();
    if (s[r.i] === '"' || s[r.i] === "'") {
      const v = r.string();
      if (v === undefined) break;
      props.set(key, v);
    } else if (s[r.i] === '{') {
      const start = r.i;
      r.i++;
      const v = r.value();
      r.ws();
      if (v !== NOT_LITERAL && s[r.i] === '}') {
        props.set(key, v);
        r.i++;
      } else {
        r.i = start;
        if (!r.skipBraces()) break;
      }
    } else break;
  }
  return props;
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
      const key =
        ch === '"' || ch === "'"
          ? this.string()
          : /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i))?.[0];
      if (key === undefined) return NOT_LITERAL;
      if (ch !== '"' && ch !== "'") this.i += key.length;
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

// ---- DOM --------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 600;
const H = 72;

/** Replace `host`'s children with the block's quiet view. */
export function renderMdxSummary(host: HTMLElement, summary: MdxSummary): void {
  host.replaceChildren();
  host.dataset.kind = summary.kind;
  const head = document.createElement('div');
  head.className = 'mdx-head';
  const label = document.createElement('span');
  label.className = summary.kind === 'jsx' ? 'mdx-name' : 'mdx-muted';
  label.textContent = summary.label;
  head.appendChild(label);
  if (summary.title) {
    const title = document.createElement('span');
    title.className = 'mdx-title';
    title.textContent = summary.title;
    head.appendChild(title);
  }
  host.appendChild(head);
  if (summary.points) host.appendChild(lineOf(summary.points));
  if (summary.children) {
    const kids = document.createElement('div');
    kids.className = 'mdx-children';
    kids.textContent = summary.children;
    host.appendChild(kids);
  }
}

function lineOf(points: Array<{ x: number; y: number }>): SVGSVGElement {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const dx = Math.max(...xs) - x0 || 1;
  const dy = Math.max(...ys) - y0 || 1;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'mdx-preview');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute(
    'points',
    points
      .map(
        (p) =>
          `${(((p.x - x0) / dx) * (W - 8) + 4).toFixed(1)},${(H - 4 - ((p.y - y0) / dy) * (H - 8)).toFixed(1)}`,
      )
      .join(' '),
  );
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(line);
  return svg;
}
