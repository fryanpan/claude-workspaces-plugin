/**
 * What an `.mdx` block shows in place of its source: a component's `title` and
 * words, the chart its literal props describe (`mdx-chart.ts`), a muted line
 * for a comment or the imports. A component's name shows only when it has
 * nothing else to show.
 *
 * The source is somebody's document text, so nothing here runs it. Props are
 * read by a literal parser that knows numbers, strings, booleans, null, arrays
 * and plain objects, and returns undefined for anything else — a variable, a
 * call, a spread. Every string reaches the DOM through `textContent`.
 */

import { type MdxChart, chartOf, drawChart, seriesColor } from './mdx-chart.ts';

export type MdxKind = 'esm' | 'expr' | 'jsx';

export interface MdxSummary {
  kind: MdxKind;
  /** The line shown: a component's name, a comment's words, the imports. */
  label: string;
  /** A component's `title` prop, when it is a string literal. */
  title?: string;
  /** The chart its props describe, when they are literals of a chart's shape. */
  chart?: MdxChart;
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
  const chart = chartOf(props);
  if (chart) summary.chart = chart;
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

// ---- DOM --------------------------------------------------------------------

/** Width a chart is drawn at when its block has not been laid out yet. */
const DEFAULT_WIDTH = 640;

/** Replace `host`'s children with the block's quiet view, a chart drawn
 *  `width` pixels wide (the host's own width when it has one). */
export function renderMdxSummary(host: HTMLElement, summary: MdxSummary, width?: number): void {
  host.replaceChildren();
  host.dataset.kind = summary.kind;
  const head = document.createElement('div');
  head.className = 'mdx-head';
  // A component's name is source vocabulary, not what the post says, so it
  // shows only when the block would otherwise be empty.
  const bare = !summary.title && !summary.chart && !summary.children;
  if (summary.kind !== 'jsx' || bare) {
    const label = document.createElement('span');
    label.className = summary.kind === 'jsx' ? 'mdx-name' : 'mdx-muted';
    label.textContent = summary.label;
    head.appendChild(label);
  }
  if (summary.title) {
    const title = document.createElement('span');
    title.className = 'mdx-title';
    title.textContent = summary.title;
    head.appendChild(title);
  }
  if (head.childElementCount > 0) host.appendChild(head);
  const { chart } = summary;
  if (chart) {
    if (chart.type === 'line' && chart.series.some((s) => s.label)) {
      host.appendChild(legendOf(chart.series));
    }
    host.appendChild(drawChart(chart, width || host.clientWidth || DEFAULT_WIDTH));
  }
  if (summary.children) {
    const kids = document.createElement('div');
    kids.className = 'mdx-children';
    kids.textContent = summary.children;
    host.appendChild(kids);
  }
}

function legendOf(series: Array<{ label?: string; dashed: boolean }>): HTMLElement {
  const legend = document.createElement('div');
  legend.className = 'mdx-legend';
  series.forEach((s, i) => {
    const item = document.createElement('span');
    item.className = 'mdx-legend-item';
    const swatch = document.createElement('span');
    swatch.className = s.dashed ? 'mdx-swatch is-dashed' : 'mdx-swatch';
    swatch.style.borderTopColor = seriesColor(i);
    item.append(swatch, s.label ?? `Series ${i + 1}`);
    legend.appendChild(item);
  });
  return legend;
}
