// plot-spec.mjs: the canonical copy, in claude-workspaces packages/core/src. Version 11 (2026-10-11, sha256 309aaa1dfa56921b). Other repos copy these bytes verbatim and compare this line; `tail -n +2` of the file hashes to that sha256 prefix.
// @ts-check

/**
 * The `<PlotChart>` spec turned into an Observable Plot chart, without
 * evaluating anything: every name the spec gives is looked up in an
 * allowlist, every `data` reference is a key into the spec's own `data` or an
 * inline array, a format is one of a few names, and every other string is
 * handed to Plot as the field name or constant it already is.
 *
 * A spec is either `marks`, each one
 * `Plot[mark](data, Plot[pointer](Plot[transform](options)))` with whichever
 * wrapper it does not name left out, or a `preset` that expands into exactly
 * such marks (`expandPreset`). The pointer wraps the transform, so a tip sees
 * the stacked positions. The chart is `Plot.plot({ ...house, ...options,
 * marks })`: the house style is the default here, so no renderer adds its own,
 * and a spec's options override it. Every colour and the font are CSS
 * variables with a fallback, so a page restyles a chart by setting them.
 *
 * The whole spec is checked before any Plot function is called, so a bad spec
 * draws nothing and throws a `PlotSpecError` whose message the caller shows.
 *
 * Plain JavaScript importing nothing: sf-works runs it under Node as it is.
 */

export const PLOT_SPEC_VERSION = 11;

export const PLOT_MARKS = /* @__PURE__ */ Object.freeze([
  'areaY',
  'areaX',
  'lineY',
  'lineX',
  'barY',
  'barX',
  'dot',
  'ruleY',
  'ruleX',
  'text',
  'tip',
  'rectY',
  'cell',
  'tickX',
  'tickY',
]);

export const PLOT_TRANSFORMS = /* @__PURE__ */ Object.freeze([
  'stackY',
  'stackY1',
  'stackY2',
  'stackX',
  'stackX1',
  'stackX2',
  'binX',
  'groupX',
  'groupY',
]);

export const PLOT_POINTERS = /* @__PURE__ */ Object.freeze(['pointerX', 'pointerY']);

export const PLOT_PRESETS = /* @__PURE__ */ Object.freeze(['stackedArea', 'lines', 'barsH']);

export const PLOT_FORMATS = /* @__PURE__ */ Object.freeze([
  'int',
  'pct',
  'usd',
  'comma',
  'schoolYear',
]);

/** The transforms that take an `outputs` object, and the reducers it may name. */
export const PLOT_OUTPUT_TRANSFORMS = /* @__PURE__ */ Object.freeze(['groupX', 'groupY', 'binX']);
export const PLOT_REDUCERS = /* @__PURE__ */ Object.freeze([
  'count',
  'sum',
  'mean',
  'median',
  'min',
  'max',
  'first',
  'last',
]);

/** A chart's height when its spec names none; the width follows the page. */
export const PLOT_DEFAULT_HEIGHT = 400;
export const PLOT_DEFAULT_WIDTH = 640;

/** A height per bar, and the axis and padding around them, for `barsH`. */
const BAR_ROW = 36;
const BAR_FRAME = 50;

/** The house palette and type, each a CSS variable a page may set. */
export const HOUSE = /* @__PURE__ */ Object.freeze({
  font: 'var(--chart-font, system-ui, -apple-system, "Segoe UI", sans-serif)',
  seq3: 'var(--seq-3, #2f7d76)',
  seq2: 'var(--seq-2, #c8a25e)',
  seq1: 'var(--seq-1, #9c5f3c)',
  ink: 'var(--ink, #15181c)',
  muted: 'var(--muted, #59626f)',
  rule: 'var(--rule, #dfe3e9)',
  paper: 'var(--paper, #fff)',
});

/** Options a mark may not take: a link's URL comes from the data, and the
 *  data is somebody's document text. */
const REFUSED_MARK_OPTIONS = /* @__PURE__ */ Object.freeze(['href', 'target']);

/** Scale options whose `tickFormat` may name a format. */
const SCALES = /* @__PURE__ */ Object.freeze([
  'x',
  'y',
  'fx',
  'fy',
  'color',
  'r',
  'opacity',
  'length',
]);

/** Rough width of a 13px label's glyph, for margins that fit end labels. */
const CH = 7.5;

/**
 * @typedef {'bad-spec' | 'unknown-mark' | 'unknown-transform' | 'unknown-pointer' | 'unknown-preset' | 'unknown-format' | 'unknown-reducer' | 'missing-data' | 'refused-option'} PlotSpecErrorCode
 */

/**
 * @typedef {object} PlotMarkSpec
 * @property {string} mark
 * @property {string | unknown[]} [data] A key into the spec's `data`, or the rows themselves.
 * @property {string} [transform]
 * @property {string} [pointer]
 * @property {Record<string, string>} [outputs] For groupX, groupY and binX: each output channel's reducer.
 * @property {Record<string, unknown>} [options]
 */

/**
 * @typedef {object} PlotSpec
 * @property {Record<string, unknown>} [data]
 * @property {Record<string, unknown>} [options]
 * @property {unknown} [marks]
 * @property {unknown} [preset]
 */

/**
 * A spec in its marks form, as a preset expands. `grid` is the axis the house
 * grid runs across, or false for none.
 * @typedef {{ data: Record<string, unknown>, options: Record<string, unknown>, marks: PlotMarkSpec[], grid: 'x' | 'y' | false }} ExpandedSpec
 */

/**
 * The Plot module, or any object carrying the functions a spec names.
 * @typedef {Record<string, unknown>} PlotModule
 */

/** Why a spec cannot be drawn, in words a reader can act on. */
export class PlotSpecError extends Error {
  /**
   * @param {PlotSpecErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'PlotSpecError';
    /** @type {PlotSpecErrorCode} */
    this.code = code;
  }
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {readonly string[]} list
 * @param {unknown} name
 * @returns {name is string}
 */
const allowed = (list, name) => typeof name === 'string' && list.includes(name);

/** @param {unknown} v */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// ---- formats ----------------------------------------------------------------

/** @type {Record<string, Intl.NumberFormat>} */
const NUMBER_FORMATS = {
  int: /* @__PURE__ */ new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
    useGrouping: false,
  }),
  comma: /* @__PURE__ */ new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }),
  // A percent axis runs 0 to 100, so 43 reads "43%"; Intl's own percent
  // style would multiply by 100.
  pct: /* @__PURE__ */ new Intl.NumberFormat('en-US', {
    style: 'unit',
    unit: 'percent',
    maximumFractionDigits: 1,
  }),
  usd: /* @__PURE__ */ new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }),
  // Cents show only when a value has them: $1,200, and $12.50 rather than $12.5.
  usdCents: /* @__PURE__ */ new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }),
};

/**
 * The function a named format stands for: "int", "pct", "usd", "comma", or
 * "schoolYear" (2005 reads "2005-06").
 * @param {unknown} name
 * @returns {(v: unknown) => string}
 */
export function plotFormat(name) {
  if (!allowed(PLOT_FORMATS, name)) {
    throw new PlotSpecError('unknown-format', `unknown format ${JSON.stringify(name)}`);
  }
  if (name === 'schoolYear') {
    return (v) => {
      if (!finite(v) || !Number.isInteger(v)) return v == null ? '' : String(v);
      const n = /** @type {number} */ (v);
      return `${n}-${String((n + 1) % 100).padStart(2, '0')}`;
    };
  }
  if (name === 'usd') {
    return (v) => {
      if (!finite(v)) return v == null ? '' : String(v);
      const n = /** @type {number} */ (v);
      return /** @type {Intl.NumberFormat} */ (
        NUMBER_FORMATS[Number.isInteger(n) ? 'usd' : 'usdCents']
      ).format(n);
    };
  }
  const nf = /** @type {Intl.NumberFormat} */ (NUMBER_FORMATS[name]);
  return (v) => (finite(v) ? nf.format(/** @type {number} */ (v)) : v == null ? '' : String(v));
}

/**
 * A tip's `format`: each channel's named format resolved; a boolean, and
 * `"d"` (Plot's own integer format, which years take), kept as they are.
 * @param {unknown} format
 * @param {string} at
 */
function tipFormat(format, at) {
  if (format === undefined) return undefined;
  if (!isRecord(format)) throw new PlotSpecError('bad-spec', `${at}: format must be an object`);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [channel, f] of Object.entries(format)) {
    out[channel] = typeof f === 'boolean' || f === null || f === 'd' ? f : plotFormat(f);
  }
  return out;
}

// ---- the marks form ---------------------------------------------------------

/**
 * Every mark of `spec`, checked against the allowlists, its data resolved and
 * its named formats turned into functions, with no Plot function called.
 * @param {PlotSpec} spec
 * @returns {Array<{ mark: string, data: unknown[], transform?: string, outputs?: Record<string, string>, pointer?: string, options: Record<string, unknown> }>}
 */
export function checkPlotSpec(spec) {
  if (!isRecord(spec)) throw new PlotSpecError('bad-spec', 'The chart has no spec');
  const data = spec.data === undefined ? {} : spec.data;
  if (!isRecord(data))
    throw new PlotSpecError('bad-spec', '`data` must be an object of named rows');
  if (spec.options !== undefined && !isRecord(spec.options)) {
    throw new PlotSpecError('bad-spec', '`options` must be an object');
  }
  if (!Array.isArray(spec.marks) || spec.marks.length === 0) {
    throw new PlotSpecError('bad-spec', '`marks` must be a list of at least one mark');
  }
  return spec.marks.map((m, i) => {
    const at = `Mark ${i + 1}`;
    if (!isRecord(m)) throw new PlotSpecError('bad-spec', `${at} is not an object`);
    if (!allowed(PLOT_MARKS, m.mark)) {
      throw new PlotSpecError('unknown-mark', `${at}: unknown mark ${JSON.stringify(m.mark)}`);
    }
    if (m.transform !== undefined && !allowed(PLOT_TRANSFORMS, m.transform)) {
      throw new PlotSpecError(
        'unknown-transform',
        `${at}: unknown transform ${JSON.stringify(m.transform)}`,
      );
    }
    if (m.pointer !== undefined && !allowed(PLOT_POINTERS, m.pointer)) {
      throw new PlotSpecError(
        'unknown-pointer',
        `${at}: unknown pointer ${JSON.stringify(m.pointer)}`,
      );
    }
    const outputs = outputsOf(m, at);
    const options = m.options === undefined ? {} : m.options;
    if (!isRecord(options)) throw new PlotSpecError('bad-spec', `${at}: options must be an object`);
    for (const key of REFUSED_MARK_OPTIONS) {
      if (Object.hasOwn(options, key)) {
        throw new PlotSpecError('refused-option', `${at}: the ${key} option is not allowed`);
      }
    }
    const format = tipFormat(options.format, at);
    return {
      mark: m.mark,
      data: rowsOf(data, m.data, at),
      ...(m.transform === undefined ? {} : { transform: m.transform }),
      ...(outputs === undefined ? {} : { outputs }),
      ...(m.pointer === undefined ? {} : { pointer: m.pointer }),
      options: { ...houseMarkOptions(m.mark), ...options, ...(format ? { format } : {}) },
    };
  });
}

/**
 * A mark's `outputs`, the transform's first argument: allowed only on a
 * transform that reduces, and each value a reducer from the allowlist.
 * @param {Record<string, unknown>} m
 * @param {string} at
 * @returns {Record<string, string> | undefined}
 */
function outputsOf(m, at) {
  if (m.outputs === undefined) return undefined;
  if (!allowed(PLOT_OUTPUT_TRANSFORMS, m.transform)) {
    throw new PlotSpecError('bad-spec', `${at}: outputs need a groupX, groupY or binX transform`);
  }
  if (!isRecord(m.outputs)) throw new PlotSpecError('bad-spec', `${at}: outputs must be an object`);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [channel, reducer] of Object.entries(m.outputs)) {
    if (!allowed(PLOT_REDUCERS, reducer)) {
      throw new PlotSpecError(
        'unknown-reducer',
        `${at}: unknown reducer ${JSON.stringify(reducer)} for ${channel}`,
      );
    }
    out[channel] = reducer;
  }
  return out;
}

/**
 * @param {Record<string, unknown>} data
 * @param {unknown} ref
 * @param {string} at
 * @returns {unknown[]}
 */
function rowsOf(data, ref, at) {
  if (Array.isArray(ref)) return ref;
  if (typeof ref === 'string') {
    const named = Object.hasOwn(data, ref) ? data[ref] : undefined;
    if (!Array.isArray(named)) {
      throw new PlotSpecError('missing-data', `${at}: no data named ${JSON.stringify(ref)}`);
    }
    return named;
  }
  throw new PlotSpecError('missing-data', `${at} has no data`);
}

// ---- the house style --------------------------------------------------------

/**
 * Text wears a halo in the paper colour, so it reads where a mark crosses it;
 * a tip is edged in the rule colour.
 * @param {string} mark
 * @returns {Record<string, unknown>}
 */
function houseMarkOptions(mark) {
  if (mark === 'text') return { fill: HOUSE.ink, stroke: HOUSE.paper, strokeWidth: 3 };
  if (mark === 'tip') return { stroke: HOUSE.rule };
  return {};
}

/** @param {string} key */
const camel = (key) =>
  key.startsWith('--') ? key : key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/**
 * The chart's inline style, the house font, size and ink under the spec's
 * own, split in two: properties Plot assigns one by one, and custom
 * properties (the tip's `--plot-background`, a page's own variables), which
 * cannot be assigned that way and are set on the drawn SVG instead.
 * @param {unknown} style
 * @returns {{ plain: Record<string, string>, custom: Record<string, string> }}
 */
function houseStyle(style) {
  /** @type {Record<string, string>} */
  const all = {
    fontFamily: HOUSE.font,
    fontSize: '13px',
    color: HOUSE.muted,
    background: 'transparent',
    '--plot-background': HOUSE.paper,
  };
  const own =
    typeof style === 'string'
      ? style.split(';').map((d) => {
          const i = d.indexOf(':');
          return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
        })
      : isRecord(style)
        ? Object.entries(style)
        : [];
  for (const [k, v] of own) {
    if (typeof k === 'string' && k !== '' && (typeof v === 'string' || finite(v))) {
      all[camel(k)] = String(v);
    }
  }
  /** @type {Record<string, string>} */
  const plain = {};
  /** @type {Record<string, string>} */
  const custom = {};
  for (const [k, v] of Object.entries(all)) (k.startsWith('--') ? custom : plain)[k] = v;
  return { plain, custom };
}

/** Colour options that already say which colours a scale uses. */
const COLOR_SCHEMES = /* @__PURE__ */ Object.freeze(['range', 'scheme', 'type', 'interpolate']);

/**
 * The plot options: the house defaults under the spec's, each scale's named
 * `tickFormat` resolved; `"d"` goes to Plot as its own integer format.
 * @param {Record<string, unknown>} options
 */
function houseOptions(options) {
  /** @type {Record<string, unknown>} */
  const out = { ...options, style: houseStyle(options.style).plain };
  for (const axis of ['x', 'y']) {
    const own = options[axis];
    if (own === undefined || isRecord(own)) out[axis] = { tickSize: 0, label: null, ...own };
  }
  const color = isRecord(options.color) ? options.color : {};
  const ownScheme = COLOR_SCHEMES.some((k) => k in color);
  if (options.color === undefined || (isRecord(options.color) && !ownScheme)) {
    out.color = { range: [HOUSE.seq3, HOUSE.seq2, HOUSE.seq1], ...color };
  }
  for (const scale of SCALES) {
    const s = out[scale];
    if (isRecord(s) && typeof s.tickFormat === 'string' && s.tickFormat !== 'd') {
      out[scale] = { ...s, tickFormat: plotFormat(s.tickFormat) };
    }
  }
  return out;
}

/**
 * The house grid: dashed in the rule colour across the value axis, under a
 * solid zero line. None when the spec asks for Plot's own grid.
 * @param {PlotModule} Plot
 * @param {Record<string, unknown>} options
 * @param {'x' | 'y' | false} grid
 * @returns {Array<() => unknown>}
 */
function houseGrid(Plot, options, grid) {
  if (!grid || options.grid !== undefined) return [];
  const scale = options[grid];
  if (isRecord(scale) && scale.grid !== undefined) return [];
  const gridMark = fn(Plot, grid === 'y' ? 'gridY' : 'gridX');
  const rule = fn(Plot, grid === 'y' ? 'ruleY' : 'ruleX');
  return [
    () => gridMark({ stroke: HOUSE.rule, strokeOpacity: 1, strokeDasharray: '2 4' }),
    () => rule([0], { stroke: HOUSE.rule, clip: true }),
  ];
}

// ---- presets ----------------------------------------------------------------

/**
 * @param {Record<string, unknown>} preset
 * @param {string} key
 * @returns {string}
 */
function field(preset, key) {
  const v = preset[key];
  if (typeof v !== 'string' || v === '') {
    throw new PlotSpecError('bad-spec', `The ${preset.type} preset needs a field name in "${key}"`);
  }
  return v;
}

/**
 * @param {Record<string, unknown>} preset
 * @param {string} key
 * @returns {string | undefined}
 */
function optionalField(preset, key) {
  return preset[key] === undefined ? undefined : field(preset, key);
}

/**
 * The preset's named formats, keyed `x` / `y` (or `value` for bars).
 * @param {Record<string, unknown>} preset
 * @returns {Record<string, string>}
 */
function formatsOf(preset) {
  if (preset.format === undefined) return {};
  if (!isRecord(preset.format)) {
    throw new PlotSpecError('bad-spec', 'A preset’s format must be an object of named formats');
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(preset.format)) {
    plotFormat(v);
    out[k] = /** @type {string} */ (v);
  }
  return out;
}

/**
 * A goal or baseline: a value and an optional label.
 * @param {unknown} v
 * @param {string} name
 * @returns {{ value: number, label?: string } | undefined}
 */
function lineOf(v, name) {
  if (v === undefined) return undefined;
  if (!isRecord(v) || !finite(v.value)) {
    throw new PlotSpecError('bad-spec', `A preset’s ${name} needs a numeric "value"`);
  }
  const label = typeof v.label === 'string' ? v.label : undefined;
  return { value: /** @type {number} */ (v.value), ...(label === undefined ? {} : { label }) };
}

/** A preset's `data`, which `rowsOf` has already resolved.
 *  @param {Record<string, unknown>} p */
const dataRef = (p) => /** @type {string | unknown[]} */ (p.data);

/** @param {unknown} row @param {string} key */
const get = (row, key) => (isRecord(row) ? row[key] : undefined);

/**
 * The series in the order the preset names, then any it left out, in the
 * order the rows first carry them.
 * @param {unknown[]} rows
 * @param {string} series
 * @param {unknown} order
 * @returns {string[]}
 */
function seriesOrder(rows, series, order) {
  const seen = [
    ...new Set(
      rows
        .map((r) => get(r, series))
        .filter((s) => s != null)
        .map(String),
    ),
  ];
  const named = Array.isArray(order) ? order.map(String) : [];
  return [...named.filter((s) => seen.includes(s)), ...seen.filter((s) => !named.includes(s))];
}

/** Round ticks from 0 to past `max`. @param {number} max */
function zeroTicks(max) {
  const raw = Math.max(max, 1) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const err = raw / mag;
  const step = mag * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let k = 0; k * step <= top + step * 1e-9; k++)
    ticks.push(Number((k * step).toPrecision(12)));
  return ticks;
}

/**
 * The goal rule and its label at the plot's right edge.
 * @param {{ value: number, label?: string } | undefined} goal
 * @param {(v: unknown) => string} fmt
 * @param {Record<string, unknown>} fit How a label fits the margin: `endLayout`'s.
 * @param {number} [labelY] Where the label sits on y, when moved off the rule.
 * @returns {PlotMarkSpec[]}
 */
function goalMarks(goal, fmt, fit, labelY = goal?.value) {
  if (!goal) return [];
  return [
    goalRule(goal),
    {
      mark: 'text',
      data: [{ y: labelY, label: goal.label ?? fmt(goal.value) }],
      options: { y: 'y', text: 'label', frameAnchor: 'right', textAnchor: 'start', dx: 8, ...fit },
    },
  ];
}

/** The goal's dashed rule. @param {{ value: number }} goal @returns {PlotMarkSpec} */
const goalRule = (goal) => ({
  mark: 'ruleY',
  data: [goal.value],
  options: { stroke: HOUSE.ink, strokeDasharray: '6 4' },
});

/** The right margin that fits the longest end label. @param {string[]} labels */
const endMargin = (labels) => Math.ceil(Math.max(0, ...labels.map((l) => l.length)) * CH) + 16;

/** Below this width a chart's end labels take two lines and at most a third of it. */
const NARROW = 600;

/**
 * How the end labels and the goal label at the plot's right are set. At
 * `NARROW` or wider, each end label is "<series> <value>" on one line and the
 * margin fits the longest. Narrower, each is the series over its value, the
 * margin fits the longest line but takes no more than a third of the width,
 * and a line still too wide for it ends in an ellipsis.
 * @param {Array<{ series: string, value: string }>} ends
 * @param {string | undefined} goal
 * @param {number | undefined} width
 * @param {Record<string, unknown>} own
 * @param {number} [inset] Px before each end label, for a swatch.
 */
function endLayout(ends, goal, width, own, inset = 0) {
  if (!(finite(width) && /** @type {number} */ (width) < NARROW)) {
    const label = (/** @type {{ series: string, value: string }} */ e) => `${e.series} ${e.value}`;
    const margin = Math.max(endMargin(ends.map(label)) + inset, endMargin([goal ?? '']));
    return { label, margin, fit: {} };
  }
  const label = (/** @type {{ series: string, value: string }} */ e) => `${e.series}\n${e.value}`;
  const lines = [...ends.flatMap((e) => [e.series, e.value]), goal ?? ''];
  const margin = Math.min(endMargin(lines) + inset, Math.floor(/** @type {number} */ (width) / 3));
  const room = finite(own.marginRight) ? /** @type {number} */ (own.marginRight) : margin;
  // Plot measures a line in ems of the 13px house text; 16px is the dx and a gap.
  const fit = { lineWidth: Math.max(0, room - 16 - inset) / 13, textOverflow: 'ellipsis' };
  return { label, margin, fit };
}

/** A label's height in px, the smaller one a thin band takes, and the gap a
 *  label keeps from each edge of its band. */
const LINE = 13;
const SMALL = 11;
const PAD = 2;

/**
 * A 13px label's width in px, by glyph class. System-ui in Chrome measured
 * "Biking" at 37px where seven and a half a glyph says 45, and a thin band's
 * window is that much shorter. Each class sits near its widest common glyph,
 * plus 5% for fonts that run wider; a glyph past Latin is taken as 1em.
 * @param {string} text
 */
const labelWidth = (text) =>
  1.05 *
  [...text].reduce(
    (w, c) =>
      w +
      ((c.codePointAt(0) ?? 0) > 0x24f
        ? LINE
        : /[ijlI.,:;!|' ]/.test(c)
          ? 3.6
          : /[ftr()/]/.test(c)
            ? 5
            : /[mwMW%@]/.test(c)
              ? 11.5
              : /[A-Z0-9&]/.test(c)
                ? 9.5
                : 7.5),
    0,
  );

/** The least right margin of a narrow stacked chart, whose labels sit
 *  inside it, and the width of a tick label's glyph: tabular digits at 13px,
 *  "2025-26" measured 55px in Chrome. */
const INSIDE_MARGIN = 20;
const TICK_CH = 8;

/**
 * The right margin of a narrow stacked chart: room for half the widest x
 * tick label, centred on the plot's right edge, and never less than
 * `INSIDE_MARGIN`.
 * @param {unknown[]} rows
 * @param {string} x
 * @param {Record<string, unknown>} own
 * @param {string | undefined} format
 */
function insideMargin(rows, x, own, format) {
  const ownX = isRecord(own.x) ? own.x : {};
  const ticks = Array.isArray(ownX.ticks) ? ownX.ticks : rows.map((r) => get(r, x));
  const named = typeof ownX.tickFormat === 'string' ? ownX.tickFormat : format;
  const f = named === undefined || named === 'd' ? String : plotFormat(named);
  const widest = Math.max(0, ...ticks.filter(finite).map((t) => f(t).length));
  return Math.max(INSIDE_MARGIN, Math.ceil((widest * TICK_CH) / 2) + 2);
}
/** Scale options that move a value's pixel away from the linear map. */
const SCALE_SHAPES = ['type', 'reverse', 'range', 'nice'];

/**
 * @typedef {{ x: number, y: number, series: string, label: string }} InsideLabel
 * @typedef {'left' | 'right' | 'along'} InsideSide
 * @typedef {{ side: InsideSide, size: number, labels: InsideLabel[] }} InsideGroup
 * @typedef {{ groups: InsideGroup[], events: LaidEvent[], goal?: { y: number, label: string, lineWidth: number } }} Inside
 */

/**
 * The plot's frame in pixels: the spec's margins, else Plot's defaults (40
 * left, 20 top, 30 bottom) and `rightMargin`.
 * @param {Record<string, unknown>} own
 * @param {number} width
 * @param {number} rightMargin
 */
function frameOf(own, width, rightMargin) {
  const margin = (/** @type {string} */ k, /** @type {number} */ d) =>
    /** @type {number} */ (finite(own[k]) ? own[k] : finite(own.margin) ? own.margin : d);
  const height = finite(own.height) ? /** @type {number} */ (own.height) : PLOT_DEFAULT_HEIGHT;
  return {
    left: margin('marginLeft', 40),
    right: width - margin('marginRight', rightMargin),
    top: margin('marginTop', 20),
    bottom: height - margin('marginBottom', 30),
  };
}

/**
 * @typedef {{ x: number, label: string }} PlotEvent
 * @typedef {{ x: number, label: string, side: 'start' | 'end', box?: { a: number, b: number, top: number, bottom: number } }} LaidEvent
 */

/**
 * A preset's `events`: each a value on x and an optional label.
 * @param {unknown} v
 * @returns {PlotEvent[]}
 */
function eventsOf(v) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new PlotSpecError('bad-spec', 'A preset’s events must be a list');
  return v.map((e, i) => {
    if (!isRecord(e) || !finite(e.x)) {
      throw new PlotSpecError('bad-spec', `Event ${i + 1} needs a numeric "x"`);
    }
    return { x: /** @type {number} */ (e.x), label: typeof e.label === 'string' ? e.label : '' };
  });
}

/**
 * The x extent a preset's chart spans: the spec's own domain, else every x
 * its rows and events carry. Undefined for an x that is not a number.
 * @param {unknown[]} rows
 * @param {string} x
 * @param {Record<string, unknown>} own
 * @param {PlotEvent[]} events
 * @returns {[number, number] | undefined}
 */
function xExtent(rows, x, own, events) {
  const d = isRecord(own.x) ? own.x.domain : undefined;
  if (Array.isArray(d) && d.length === 2 && d.every(finite)) {
    return [/** @type {number} */ (d[0]), /** @type {number} */ (d[1])];
  }
  const xs = rows.map((r) => get(r, x));
  if (xs.length === 0 || !xs.every(finite)) return undefined;
  const all = [...xs.map(Number), ...events.map((e) => e.x)];
  return [Math.min(...all), Math.max(...all)];
}

/**
 * Where each event's label goes: at the top of the plot, on whichever side
 * of its rule has more of the x range. Given the plot's frame in pixels
 * (below `NARROW`), a label wider than its side's room wraps once, at the
 * space nearest its middle, and `box` is the pixels it covers.
 * @param {PlotEvent[]} events
 * @param {[number, number] | undefined} extent
 * @param {{ left: number, right: number, top: number }} [frame]
 * @returns {LaidEvent[]}
 */
function eventLayout(events, extent, frame) {
  return events.map((e) => {
    const [x0, x1] = extent ?? [e.x, e.x];
    const share = x1 > x0 ? (e.x - x0) / (x1 - x0) : 0;
    /** @type {'start' | 'end'} */
    const side = share > 0.5 ? 'end' : 'start';
    if (!frame) return { x: e.x, label: e.label, side };
    const at = frame.left + share * (frame.right - frame.left);
    const room = (side === 'start' ? frame.right - at : at - frame.left) - 8;
    let label = e.label;
    if (label.length * CH > room && label.includes(' ')) {
      const mid = label.length / 2;
      const cut = [...label.matchAll(/ /g)]
        .map((m) => /** @type {number} */ (m.index))
        .sort((m, n) => Math.abs(m - mid) - Math.abs(n - mid))[0];
      if (cut !== undefined) label = `${label.slice(0, cut)}\n${label.slice(cut + 1)}`;
    }
    const lines = label.split('\n');
    const w = Math.max(...lines.map((l) => l.length)) * CH;
    const a = side === 'start' ? at + 4 : at - 4 - w;
    const top = frame.top + 4;
    return { x: e.x, label, side, box: { a, b: a + w, top, bottom: top + lines.length * LINE } };
  });
}

/**
 * Each event's dashed rule in the muted ink, and its label at the plot's top.
 * @param {LaidEvent[]} laid
 * @returns {PlotMarkSpec[]}
 */
function eventMarks(laid) {
  if (laid.length === 0) return [];
  /** @type {PlotMarkSpec[]} */
  const marks = [
    {
      mark: 'ruleX',
      data: laid.map((e) => e.x),
      options: { stroke: HOUSE.muted, strokeDasharray: '4 4' },
    },
  ];
  for (const side of /** @type {const} */ (['start', 'end'])) {
    const data = laid.filter((e) => e.side === side && e.label !== '');
    if (data.length === 0) continue;
    marks.push({
      mark: 'text',
      data: data.map(({ x, label }) => ({ x, label })),
      options: {
        x: 'x',
        text: 'label',
        frameAnchor: 'top',
        lineAnchor: 'top',
        textAnchor: side,
        dx: side === 'start' ? 4 : -4,
        dy: 4,
        fill: HOUSE.muted,
      },
    });
  }
  return marks;
}

/**
 * Below `NARROW`, where a stacked chart's labels go instead of its right
 * margin: each series' name inside its own band, and the goal's label above
 * its rule at the left. A label fits where its line, `PAD` clear of both
 * edges, lies inside the band all along its width and clear of each event's
 * rule and label, the goal's rule and label, and every label already placed. Each series takes the
 * first of these that fits: at 13px, at the first x reading rightward or the
 * last x reading leftward, whichever leaves more room; at 13px, wherever
 * along the band leaves most room; the same two at 11px; for the top band
 * only, at 13px just above it. A band too thin for all of them goes
 * unlabelled, and its tip still names it. Positions are the pixels Plot will draw at, from the
 * spec's margins or Plot's defaults (40 left, 20 top, 30 bottom). Undefined
 * when those pixels cannot be known here: an x that is not a number, a
 * negative value (it stacks below zero), an inset, or a scale whose type,
 * direction, range or rounding the spec sets.
 * @param {unknown[]} rows
 * @param {{ x: string, y: string, series: string, order: string[] }} f
 * @param {{ value: number, label?: string } | undefined} goal
 * @param {(v: unknown) => string} fmt
 * @param {Record<string, unknown>} own
 * @param {number} width
 * @param {number} rightMargin The margin the chart takes when the spec sets none.
 * @param {PlotEvent[]} events Their labels are placed first, and kept clear of.
 * @returns {Inside | undefined}
 */
function insideLabels(rows, f, goal, fmt, own, width, rightMargin, events) {
  const ownX = isRecord(own.x) ? own.x : {};
  const ownY = isRecord(own.y) ? own.y : {};
  const reshaped = (/** @type {Record<string, unknown>} */ o, /** @type {string[]} */ keys) =>
    Object.keys(o).some((k) => keys.includes(k) || k.startsWith('inset'));
  if (reshaped(own, []) || [ownX, ownY].some((s) => reshaped(s, SCALE_SHAPES))) return undefined;
  if (!rows.every((r) => finite(get(r, f.x)))) return undefined;
  if (rows.some((r) => finite(get(r, f.y)) && Number(get(r, f.y)) < 0)) return undefined;
  const xs = [...new Set(rows.map((r) => Number(get(r, f.x))))].sort((a, b) => a - b);
  if (xs.length < 2) return undefined;
  /** @type {Map<string, number>} */
  const sums = new Map();
  for (const r of rows) {
    const k = `${get(r, f.x)}|${get(r, f.series)}`;
    const v = get(r, f.y);
    sums.set(k, (sums.get(k) ?? 0) + (finite(v) ? Number(v) : 0));
  }
  const bands = f.order.map(() => ({
    lo: /** @type {number[]} */ ([]),
    hi: /** @type {number[]} */ ([]),
  }));
  const totals = xs.map((xv) => {
    let base = 0;
    f.order.forEach((s, i) => {
      const band = /** @type {{ lo: number[], hi: number[] }} */ (bands[i]);
      band.lo.push(base);
      base += sums.get(`${xv}|${s}`) ?? 0;
      band.hi.push(base);
    });
    return base;
  });
  const pair = (/** @type {unknown} */ d) =>
    Array.isArray(d) && d.length === 2 && d.every(finite) ? /** @type {number[]} */ (d) : undefined;
  const [x0, x1] = pair(ownX.domain) ?? [
    Math.min(/** @type {number} */ (xs[0]), ...events.map((e) => e.x)),
    Math.max(/** @type {number} */ (xs.at(-1)), ...events.map((e) => e.x)),
  ];
  const [y0, y1] = pair(ownY.domain) ?? [0, Math.max(...totals, goal?.value ?? 0)];
  const { left, right, top, bottom } = frameOf(own, width, rightMargin);
  if (!(x1 > x0 && y1 > y0 && right > left && bottom > top)) return undefined;
  const px = (/** @type {number} */ v) => left + ((v - x0) / (x1 - x0)) * (right - left);
  const py = (/** @type {number} */ v) => bottom - ((v - y0) / (y1 - y0)) * (bottom - top);
  const dataY = (/** @type {number} */ p) => y0 + ((bottom - p) / (bottom - top)) * (y1 - y0);
  const at = xs.map(px);
  /** A band edge's pixel y at pixel x, the area being straight between its xs. */
  const edge = (/** @type {number[]} */ vs, /** @type {number} */ p) => {
    const k = Math.max(
      1,
      at.findIndex((a) => a >= p),
    );
    const a0 = /** @type {number} */ (at[k - 1]);
    const a1 = /** @type {number} */ (at[k]);
    const t = a1 === a0 ? 0 : (p - a0) / (a1 - a0);
    return py(/** @type {number} */ (vs[k - 1]) * (1 - t) + /** @type {number} */ (vs[k]) * t);
  };
  // Pixel boxes a label must stay clear of: the events' rules and labels,
  // the goal's rule and label, then each label as it is placed.
  const laid = eventLayout(events, [x0, x1], { left, right, top });
  /** @type {Array<{ a: number, b: number, top: number, bottom: number }>} */
  const blocked = laid.flatMap((e) => [
    ...(e.box ? [e.box] : []),
    { a: px(e.x) - 1, b: px(e.x) + 1, top, bottom },
  ]);
  /** @type {Inside['goal']} */
  let goalLabel;
  if (goal) {
    const gy = py(goal.value);
    const label = goal.label ?? fmt(goal.value);
    const room = right - left - 4;
    blocked.push({ a: left, b: right, top: gy - 1, bottom: gy + 1 });
    blocked.push({
      a: left,
      b: left + 4 + Math.min(room, label.length * CH),
      top: gy - 9 - LINE / 2,
      bottom: gy - 9 + LINE / 2,
    });
    goalLabel = { y: goal.value, label, lineWidth: Math.max(0, room) / 13 };
  }
  const first = /** @type {number} */ (at[0]);
  const last = /** @type {number} */ (at.at(-1));
  /**
   * Where a label `h` tall fits over pixels a..b between two edges: the
   * centres left once every blocked box is cleared by PAD, and of those the
   * middle of the widest run, or with `low` the lowest centre of all.
   * @param {number} a @param {number} b @param {number} h
   * @param {(p: number) => number} topAt @param {(p: number) => number} bottomAt
   * @param {boolean} low
   */
  const fit = (a, b, h, topAt, bottomAt, low) => {
    if (a < first || b > last) return undefined;
    const ps = [a, b, ...at.filter((p) => p > a && p < b)];
    const lo = Math.max(...ps.map(topAt)) + PAD + h / 2;
    const hi = Math.min(...ps.map(bottomAt)) - PAD - h / 2;
    const cuts = blocked
      .filter((o) => o.a < b && o.b > a)
      .map((o) => [o.top - h / 2 - PAD, o.bottom + h / 2 + PAD])
      .sort((m, n) => /** @type {number} */ (m[0]) - /** @type {number} */ (n[0]));
    /** @type {{ from: number, to: number } | undefined} */
    let gap;
    let from = lo;
    for (const [cut, after] of [...cuts, [hi, hi]]) {
      const to = Math.min(hi, /** @type {number} */ (cut));
      if (to >= from && (low || !gap || to - from > gap.to - gap.from)) gap = { from, to };
      from = Math.max(from, /** @type {number} */ (after));
    }
    if (!gap) return undefined;
    return { room: gap.to - gap.from, cy: low ? gap.to : (gap.from + gap.to) / 2 };
  };
  /** @type {Map<string, InsideGroup>} */
  const groups = new Map();
  f.order.forEach((s, i) => {
    const band = /** @type {{ lo: number[], hi: number[] }} */ (bands[i]);
    /** @param {number} p */
    const bandTop = (p) => edge(band.hi, p);
    /** @type {Array<(p: number) => number>} */
    const inBand = [bandTop, (p) => edge(band.lo, p)];
    /** @type {Array<(p: number) => number>} */
    const above = [() => top, bandTop];
    const tries = [
      ...[LINE, SMALL].flatMap((h) => [
        { h, along: false, edges: inBand, low: false },
        { h, along: true, edges: inBand, low: false },
      ]),
      ...(i === f.order.length - 1 ? [{ h: LINE, along: false, edges: above, low: true }] : []),
    ];
    for (const t of tries) {
      const w = labelWidth(s) * (t.h / LINE);
      /** @type {Array<[InsideSide, number]>} */
      const spans = t.along
        ? Array.from(
            { length: Math.max(0, Math.floor((last - first - 8 - w) / 4)) + 1 },
            (_, k) => ['along', first + 4 + k * 4],
          )
        : [
            ['left', first + 4],
            ['right', last - 4 - w],
          ];
      /** @type {{ side: InsideSide, a: number, room: number, cy: number } | undefined} */
      let best;
      for (const [side, a] of spans) {
        const [topAt, bottomAt] = /** @type {Array<(p: number) => number>} */ (t.edges);
        const got = fit(
          a,
          a + w,
          t.h,
          /** @type {(p: number) => number} */ (topAt),
          /** @type {(p: number) => number} */ (bottomAt),
          t.low,
        );
        if (got && (!best || got.room > best.room)) best = { side, a, ...got };
      }
      if (!best) continue;
      blocked.push({ a: best.a, b: best.a + w, top: best.cy - t.h / 2, bottom: best.cy + t.h / 2 });
      const x =
        best.side === 'left'
          ? /** @type {number} */ (xs[0])
          : best.side === 'right'
            ? /** @type {number} */ (xs.at(-1))
            : x0 + ((best.a - left) / (right - left)) * (x1 - x0);
      const key = `${best.side} ${t.h}`;
      const group = groups.get(key) ?? { side: best.side, size: t.h, labels: [] };
      group.labels.push({ x, y: dataY(best.cy), series: s, label: s });
      groups.set(key, group);
      return;
    }
  });
  return {
    groups: [...groups.values()],
    events: laid,
    ...(goalLabel ? { goal: goalLabel } : {}),
  };
}

/**
 * The marks that draw `insideLabels`: a text mark per side and size, in the
 * house ink and halo, and the goal's label.
 * @param {Inside} inside
 * @returns {PlotMarkSpec[]}
 */
function insideMarks(inside) {
  /** @type {PlotMarkSpec[]} */
  const marks = [];
  if (inside.goal) {
    const { lineWidth, ...goal } = inside.goal;
    marks.push({
      mark: 'text',
      data: [goal],
      options: {
        y: 'y',
        text: 'label',
        frameAnchor: 'left',
        textAnchor: 'start',
        dx: 4,
        dy: -9,
        lineWidth,
        textOverflow: 'ellipsis',
      },
    });
  }
  for (const { side, size, labels } of inside.groups) {
    marks.push({
      mark: 'text',
      data: labels,
      options: {
        x: 'x',
        y: 'y',
        text: 'label',
        textAnchor: side === 'right' ? 'end' : 'start',
        ...(side === 'along' ? {} : { dx: side === 'left' ? 4 : -4 }),
        ...(size === LINE ? {} : { fontSize: size }),
      },
    });
  }
  return marks;
}

/**
 * A preset's series colours, in series order: Observable 10, unless the
 * preset says its series are `ordered`, which keeps the house's sequential
 * ramp, or the spec's own colour options name their colours. A spec's own
 * colour options go over these; a colour that is not an object is the
 * spec's alone.
 * @param {Record<string, unknown>} p
 * @param {string[]} order
 * @param {Record<string, unknown>} own
 * @returns {{ color?: unknown }}
 */
function seriesColor(p, order, own) {
  if (own.color !== undefined && !isRecord(own.color)) return {};
  const color = isRecord(own.color) ? own.color : {};
  const named = p.ordered === true || COLOR_SCHEMES.some((k) => k in color);
  return { color: { domain: order, ...(named ? {} : { scheme: 'observable10' }), ...color } };
}

/**
 * Whether every value is a whole number a year could be, so the axis ticks
 * "2005" and not "2,005".
 * @param {unknown[]} vs
 */
const yearLike = (vs) =>
  vs.length > 0 &&
  vs.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 1000 && v <= 3000);

/**
 * The x format a preset defaults to: `"d"` for years, `int` for other whole
 * numbers.
 * @param {unknown[]} rows
 * @param {string} x
 * @returns {string | undefined}
 */
function xFormatOf(rows, x) {
  const xs = rows.map((r) => get(r, x));
  if (yearLike(xs)) return 'd';
  return xs.length > 0 && xs.every(Number.isInteger) ? 'int' : undefined;
}

/**
 * Options a preset sets for its value axis: integer x values tick as plain
 * integers (a year is not 2,005), and a percent axis runs 0 to 100.
 * @param {Record<string, unknown>} own
 * @param {unknown[]} rows
 * @param {string} x
 * @param {Record<string, string>} formats
 * @param {'x' | 'y'} valueAxis
 */
function axisDefaults(own, rows, x, formats, valueAxis) {
  const xFormat = formats.x ?? xFormatOf(rows, x);
  const valueFormat = valueAxis === 'y' ? formats.y : formats.value;
  const ownValue = isRecord(own[valueAxis]) ? own[valueAxis] : {};
  /** @type {Record<string, unknown>} */
  const value = { ...(valueFormat ? { tickFormat: valueFormat } : {}) };
  if (valueFormat === 'pct' && !('domain' in ownValue)) value.domain = [0, 100];
  /** @type {Record<string, unknown>} */
  const out = { [valueAxis]: { ...value, ...ownValue } };
  if (valueAxis === 'y') {
    const ownX = isRecord(own.x) ? own.x : {};
    out.x = { ...(xFormat ? { tickFormat: xFormat } : {}), ...ownX };
  }
  return out;
}

/** The px a stacked chart's end label leaves for its swatch, a dot this wide;
 *  and the px kept between two end labels' lines, Chrome's box for a 13px
 *  line being about 16px tall, with 1px to spare. */
const SWATCH = 12;
const END_GAP = 4;

/**
 * Where the labels at a stacked or lines chart's right edge sit on y so that
 * no two overlap: each wants its own y; labels that would touch are set edge
 * to edge around the mean of what they want, inside the frame. The wanted ys
 * come back unchanged when the y scale is anything but plain linear.
 * @param {Array<{ y: number, lines: number }>} want
 * @param {number[]} totals The values the y scale spans from zero: each x's
 *   stacked total, or every value a line draws.
 * @param {Record<string, unknown>} own
 * @param {number} width
 * @param {number} margin
 * @returns {number[]}
 */
function spreadEnds(want, totals, own, width, margin) {
  const ownY = isRecord(own.y) ? own.y : {};
  const shaped =
    Object.keys(ownY).some((k) => SCALE_SHAPES.includes(k) || k.startsWith('inset')) ||
    Object.keys(own).some((k) => k.startsWith('inset'));
  const d = ownY.domain;
  const [y0, y1] =
    Array.isArray(d) && d.length === 2 && d.every(finite)
      ? /** @type {number[]} */ (d)
      : [0, Math.max(...totals, ...want.map((w) => w.y))];
  const { top, bottom } = frameOf(own, width, margin);
  const ys = want.map((w) => w.y);
  if (shaped || !(y1 > y0 && bottom > top) || want.length < 2) return ys;
  const py = (/** @type {number} */ v) => bottom - ((v - y0) / (y1 - y0)) * (bottom - top);
  /** @type {Array<{ at: number[], hs: number[], wants: number[], to: number }>} */
  let groups = want
    .map((w, i) => ({ i, p: py(w.y), h: w.lines * LINE + END_GAP }))
    .sort((m, n) => m.p - n.p)
    .map((m) => ({ at: [m.i], hs: [m.h], to: m.p - m.h / 2, wants: [m.p] }));
  /** Each group's top: the mean of where its labels want it, inside the frame. */
  const settle = (/** @type {{ hs: number[], wants: number[] }} */ g) => {
    let off = 0;
    const tops = g.hs.map((h, k) => {
      const t = /** @type {number} */ (g.wants[k]) - off - h / 2;
      off += h;
      return t;
    });
    const mean = tops.reduce((a, b) => a + b, 0) / tops.length;
    return Math.min(Math.max(mean, top), bottom - off);
  };
  for (let moved = true; moved; ) {
    moved = false;
    for (let k = 1; k < groups.length; k++) {
      const a = /** @type {(typeof groups)[number]} */ (groups[k - 1]);
      const b = /** @type {(typeof groups)[number]} */ (groups[k]);
      const reach = a.to + a.hs.reduce((m, n) => m + n, 0);
      if (reach <= b.to) continue;
      const g = {
        at: [...a.at, ...b.at],
        hs: [...a.hs, ...b.hs],
        wants: [...a.wants, ...b.wants],
        to: 0,
      };
      g.to = settle(g);
      groups = [...groups.slice(0, k - 1), g, ...groups.slice(k + 1)];
      moved = true;
      break;
    }
  }
  const out = [...ys];
  for (const g of groups.filter((m) => m.at.length > 1)) {
    let off = g.to;
    g.at.forEach((i, k) => {
      const h = /** @type {number} */ (g.hs[k]);
      out[i] = y0 + ((bottom - (off + h / 2)) / (bottom - top)) * (y1 - y0);
      off += h;
    });
  }
  return out;
}

/**
 * Stacked areas, one per series, each labelled at its end with its name and
 * last value in ink beside a swatch of its colour, the labels moved apart on
 * y where they would overlap (`spreadEnds`; under `NARROW`, with its name
 * inside the band itself: `insideLabels`); an optional goal rule; a tip that reads the
 * stacked positions and shows the value itself.
 * @param {Record<string, unknown>} p
 * @param {unknown[]} rows
 * @param {Record<string, unknown>} own
 * @param {number | undefined} width
 * @returns {Omit<ExpandedSpec, 'data'>}
 */
function stackedArea(p, rows, own, width) {
  const x = field(p, 'x');
  const y = field(p, 'y');
  const series = field(p, 'series');
  const formats = formatsOf(p);
  const fy = plotFormat(formats.y ?? 'comma');
  const order = seriesOrder(rows, series, p.order);
  const lastX = Math.max(
    ...rows
      .map((r) => get(r, x))
      .filter(finite)
      .map(Number),
  );
  let base = 0;
  const ends = order.map((s) => {
    const row = rows.find((r) => get(r, x) === lastX && String(get(r, series)) === s);
    const v = finite(get(row, y)) ? Number(get(row, y)) : 0;
    const mid = base + v / 2;
    base += v;
    return { x: lastX, y: mid, series: s, value: fy(v) };
  });
  const goal = lineOf(p.goal, 'goal');
  const narrow = finite(width) && /** @type {number} */ (width) < NARROW;
  const end = endLayout(ends, goal?.label, width, own, SWATCH);
  /** @type {Map<unknown, number>} */
  const totals = new Map();
  for (const r of rows) {
    const v = get(r, y);
    totals.set(get(r, x), (totals.get(get(r, x)) ?? 0) + (finite(v) ? Number(v) : 0));
  }
  const want = [
    ...ends.map((e) => ({ y: e.y, lines: narrow ? 2 : 1 })),
    ...(goal ? [{ y: goal.value, lines: 1 }] : []),
  ];
  // A negative value stacks below zero, outside the domain spreadEnds assumes.
  const spread = rows.some((r) => finite(get(r, y)) && Number(get(r, y)) < 0)
    ? want.map((w) => w.y)
    : spreadEnds(
        want,
        [...totals.values()],
        own,
        finite(width) ? /** @type {number} */ (width) : PLOT_DEFAULT_WIDTH,
        end.margin,
      );
  const labelled = ends.map(({ value, ...e }, i) => ({
    ...e,
    y: spread[i] ?? e.y,
    label: end.label({ ...e, value }),
  }));
  const key = y === 'x' || y === 'y' ? 'value' : y;
  const narrowRight = insideMargin(rows, x, own, formats.x ?? xFormatOf(rows, x));
  const events = eventsOf(p.events);
  const inside =
    finite(width) && /** @type {number} */ (width) < NARROW
      ? insideLabels(
          rows,
          { x, y, series, order },
          goal,
          fy,
          own,
          /** @type {number} */ (width),
          narrowRight,
          events,
        )
      : undefined;
  const laid =
    inside?.events ??
    eventLayout(
      events,
      xExtent(rows, x, own, events),
      narrow ? frameOf(own, /** @type {number} */ (width), end.margin) : undefined,
    );
  /** @type {PlotMarkSpec[]} */
  const labels = inside
    ? [...(goal ? [goalRule(goal)] : []), ...insideMarks(inside)]
    : [
        ...goalMarks(goal, fy, end.fit, spread[ends.length]),
        {
          mark: 'dot',
          data: labelled,
          options: { x: 'x', y: 'y', fill: 'series', r: SWATCH / 3, dx: 8 + SWATCH / 3 },
        },
        {
          mark: 'text',
          data: labelled,
          options: {
            x: 'x',
            y: 'y',
            text: 'label',
            fill: HOUSE.ink,
            textAnchor: 'start',
            dx: 8 + SWATCH,
            ...end.fit,
          },
        },
      ];
  return {
    grid: 'y',
    options: {
      marginRight: inside ? narrowRight : end.margin,
      ...own,
      ...seriesColor(p, order, own),
      ...axisDefaults(own, rows, x, formats, 'y'),
    },
    marks: [
      {
        mark: 'areaY',
        data: dataRef(p),
        transform: 'stackY',
        options: { x, y, fill: series, order },
      },
      ...eventMarks(laid),
      ...labels,
      {
        mark: 'tip',
        data: dataRef(p),
        transform: 'stackY2',
        pointer: 'pointerX',
        options: {
          x,
          y,
          fill: series,
          order,
          channels: { [key]: y },
          format: {
            x: formats.x ?? xFormatOf(rows, x) ?? 'int',
            y: false,
            [key]: formats.y ?? 'comma',
            fill: true,
          },
        },
      },
    ],
  };
}

/**
 * One line per series, each labelled at its end with its name and last
 * value in ink beside the series-colour dot that ends its line (no series
 * colour reaches 4.5:1 as text on the paper), the labels moved apart on y
 * where they would overlap (`spreadEnds`) while each dot stays on its line's
 * last point; named series dashed; an optional goal rule; an optional
 * baseline for an index or ratio chart, which then starts at zero with the
 * baseline drawn, labelled and ticked.
 * @param {Record<string, unknown>} p
 * @param {unknown[]} rows
 * @param {Record<string, unknown>} own
 * @param {number | undefined} width
 * @returns {Omit<ExpandedSpec, 'data'>}
 */
function lines(p, rows, own, width) {
  const x = field(p, 'x');
  const y = field(p, 'y');
  const series = field(p, 'series');
  const formats = formatsOf(p);
  const fy = plotFormat(formats.y ?? 'comma');
  const order = seriesOrder(rows, series, p.order);
  const dashed = Array.isArray(p.dashed) ? p.dashed.map(String) : [];
  const isDashed = (/** @type {unknown} */ r) => dashed.includes(String(get(r, series)));
  const ends = order.flatMap((s) => {
    const mine = rows.filter((r) => String(get(r, series)) === s && finite(get(r, x)));
    const last = mine.reduce(
      (a, r) => (a === undefined || Number(get(r, x)) > Number(get(a, x)) ? r : a),
      /** @type {unknown} */ (undefined),
    );
    if (last === undefined) return [];
    return [{ x: get(last, x), y: get(last, y), series: s, value: fy(get(last, y)) }];
  });
  const goal = lineOf(p.goal, 'goal');
  const baseline = lineOf(p.baseline, 'baseline');
  const baseText = baseline ? (baseline.label ?? fy(baseline.value)) : '';
  const longer = [goal?.label ?? '', baseText].reduce((a, b) => (b.length > a.length ? b : a));
  const end = endLayout(ends, longer || undefined, width, own);
  const narrow = finite(width) && /** @type {number} */ (width) < NARROW;
  const ys = rows
    .map((r) => get(r, y))
    .filter(finite)
    .map(Number);
  const want = [
    ...ends.map((e) => ({ y: Number(e.y), lines: narrow ? 2 : 1 })),
    ...(goal ? [{ y: goal.value, lines: 1 }] : []),
  ];
  // A negative value or an end with no number sits outside the domain
  // spreadEnds assumes, so those labels stay where they are.
  const spread =
    ys.some((v) => v < 0) || want.some((w) => !finite(w.y))
      ? []
      : spreadEnds(
          want,
          baseline ? [...ys, baseline.value] : ys,
          own,
          finite(width) ? /** @type {number} */ (width) : PLOT_DEFAULT_WIDTH,
          end.margin,
        );
  const dotted = ends.map(({ value: _, ...e }) => e);
  const labelled = ends.map(({ value, ...e }, i) => ({
    ...e,
    y: spread[i] ?? e.y,
    label: end.label({ ...e, value }),
  }));
  const goalY = goal ? spread[ends.length] : undefined;
  const axes = axisDefaults(own, rows, x, formats, 'y');
  const ownY = isRecord(own.y) ? own.y : {};
  if (baseline && !('domain' in ownY)) {
    const ticks = zeroTicks(Math.max(baseline.value, goal?.value ?? 0, ...ys));
    if (!ticks.includes(baseline.value)) ticks.push(baseline.value);
    axes.y = { zero: true, ticks: ticks.sort((a, b) => a - b), .../** @type {object} */ (axes.y) };
  }
  const line = (/** @type {unknown[]} */ data, /** @type {boolean} */ dash) => ({
    mark: 'lineY',
    data,
    options: {
      x,
      y,
      stroke: series,
      z: series,
      strokeWidth: 2,
      ...(dash ? { strokeDasharray: '6 4' } : {}),
    },
  });
  const solid = rows.filter((r) => !isDashed(r));
  const dash = rows.filter(isDashed);
  const events = eventsOf(p.events);
  const laid = eventLayout(
    events,
    xExtent(rows, x, own, events),
    finite(width) && /** @type {number} */ (width) < NARROW
      ? frameOf(own, /** @type {number} */ (width), end.margin)
      : undefined,
  );
  return {
    grid: 'y',
    options: {
      marginRight: end.margin,
      ...own,
      ...seriesColor(p, order, own),
      ...axes,
    },
    marks: [
      ...(baseline
        ? [
            { mark: 'ruleY', data: [baseline.value], options: { stroke: HOUSE.muted } },
            {
              mark: 'text',
              data: [{ y: baseline.value, label: baseText }],
              options: {
                y: 'y',
                text: 'label',
                frameAnchor: 'right',
                textAnchor: 'start',
                dx: 8,
                dy: baselineDy(
                  baseline.value,
                  rows,
                  y,
                  goal && { value: goal.value, labelY: goalY },
                  labelled,
                  own,
                ),
                ...end.fit,
              },
            },
          ]
        : []),
      ...(solid.length > 0 ? [line(solid, false)] : []),
      ...(dash.length > 0 ? [line(dash, true)] : []),
      ...eventMarks(laid),
      ...goalMarks(goal, fy, end.fit, goalY),
      { mark: 'dot', data: dotted, options: { x: 'x', y: 'y', fill: 'series', r: 3.5 } },
      {
        mark: 'text',
        data: labelled,
        options: {
          x: 'x',
          y: 'y',
          text: 'label',
          fill: HOUSE.ink,
          textAnchor: 'start',
          dx: 8,
          ...end.fit,
        },
      },
      {
        mark: 'tip',
        data: dataRef(p),
        pointer: 'pointerX',
        options: {
          x,
          y,
          stroke: series,
          format: {
            x: formats.x ?? xFormatOf(rows, x) ?? 'int',
            y: formats.y ?? 'comma',
            stroke: true,
          },
        },
      },
    ],
  };
}

/**
 * How far, in px, the baseline's label sits from its rule on y. It sits in
 * the right margin with the end labels, past the end dots, where no line
 * reaches; 8px above the rule, else at the nearest place on y that touches
 * no end label and no goal label. Above the rule, unmoved, when the y scale
 * is anything but plain linear.
 * @param {number} base
 * @param {unknown[]} rows
 * @param {string} y
 * @param {{ value: number, labelY?: number } | undefined} goal Its label
 *   sits at `labelY` when the end labels' spread moved it off the rule.
 * @param {Array<{ y: unknown, label: string }>} ends Where each end label sits.
 * @param {Record<string, unknown>} own
 */
function baselineDy(base, rows, y, goal, ends, own) {
  const ownY = isRecord(own.y) ? own.y : {};
  const shaped =
    Object.keys(ownY).some((k) => SCALE_SHAPES.includes(k) || k.startsWith('inset')) ||
    Object.keys(own).some((k) => k.startsWith('inset'));
  const vs = [base, ...(goal ? [goal.value] : []), ...rows.map((r) => get(r, y)).filter(finite)];
  const d = ownY.domain;
  const [y0, y1] =
    Array.isArray(d) && d.length === 2 && d.every(finite)
      ? /** @type {number[]} */ (d)
      : [Math.min(0, ...vs.map(Number)), Math.max(0, ...vs.map(Number))];
  const { top, bottom } = frameOf(own, PLOT_DEFAULT_WIDTH, 0);
  if (shaped || !(y1 !== y0 && bottom > top)) return -8;
  const py = (/** @type {unknown} */ v) => bottom - ((Number(v) - y0) / (y1 - y0)) * (bottom - top);
  const h = LINE + END_GAP;
  const taken = [
    ...ends
      .filter((e) => finite(e.y))
      .map((e) => ({ c: py(e.y), h: e.label.split('\n').length * LINE + END_GAP })),
    ...(goal ? [{ c: py(goal.labelY ?? goal.value), h }] : []),
  ];
  const want = py(base) - 8;
  const clear = (/** @type {number} */ c) => taken.every((t) => Math.abs(c - t.c) >= (t.h + h) / 2);
  const best = [want, ...taken.flatMap((t) => [t.c - (t.h + h) / 2, t.c + (t.h + h) / 2])]
    .filter(clear)
    .sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b)[0];
  return (best ?? want) - py(base);
}

/**
 * Horizontal bars in the order the rows give, each named at the left with an
 * optional muted sublabel under the name, and its value at the bar's end.
 * @param {Record<string, unknown>} p
 * @param {unknown[]} rows
 * @param {Record<string, unknown>} own
 * @returns {Omit<ExpandedSpec, 'data'>}
 */
function barsH(p, rows, own) {
  const label = field(p, 'label');
  const value = field(p, 'value');
  const sublabel = optionalField(p, 'sublabel');
  const formats = formatsOf(p);
  const fv = plotFormat(formats.value ?? 'comma');
  const names = rows.map((r) => String(get(r, label) ?? ''));
  const values = rows.map((r) => ({ label: String(get(r, label) ?? ''), value: get(r, value) }));
  const subs = sublabel
    ? rows.map((r) => ({
        label: String(get(r, label) ?? ''),
        text: String(get(r, sublabel) ?? ''),
      }))
    : [];
  const ownY = isRecord(own.y) ? own.y : {};
  const axes = axisDefaults(own, rows, label, formats, 'x');
  return {
    grid: 'x',
    options: {
      marginLeft: endMargin([...names, ...subs.map((s) => s.text)]),
      marginRight: endMargin(values.map((v) => fv(v.value))),
      ...own,
      ...axes,
      y: { domain: names, axis: null, padding: 0.3, ...ownY },
    },
    marks: [
      { mark: 'barX', data: dataRef(p), options: { y: label, x: value, fill: HOUSE.seq3 } },
      {
        mark: 'text',
        data: values.map((v) => ({ ...v, text: fv(v.value) })),
        options: { y: 'label', x: 'value', text: 'text', textAnchor: 'start', dx: 6 },
      },
      {
        mark: 'text',
        data: values.map((v) => ({ label: v.label })),
        options: {
          y: 'label',
          text: 'label',
          frameAnchor: 'left',
          textAnchor: 'end',
          dx: -8,
          ...(sublabel ? { dy: -7 } : {}),
        },
      },
      ...(sublabel
        ? [
            {
              mark: 'text',
              data: subs,
              options: {
                y: 'label',
                text: 'text',
                frameAnchor: 'left',
                textAnchor: 'end',
                dx: -8,
                dy: 8,
                fill: HOUSE.muted,
                fontSize: 11,
              },
            },
          ]
        : []),
    ],
  };
}

const PRESETS = { stackedArea, lines, barsH };

/**
 * A spec in its marks form. A preset expands into ordinary marks; a marks
 * spec passes through with the house grid across y. A preset's end labels
 * fit the width it is drawn at: `env.width`, else the spec's own width, and
 * with neither, Plot's default 640.
 * @param {PlotSpec} spec
 * @param {{ width?: number }} [env]
 * @returns {ExpandedSpec}
 */
export function expandPreset(spec, env = {}) {
  if (!isRecord(spec)) throw new PlotSpecError('bad-spec', 'The chart has no spec');
  const data = spec.data === undefined ? {} : spec.data;
  if (!isRecord(data))
    throw new PlotSpecError('bad-spec', '`data` must be an object of named rows');
  const own = spec.options === undefined ? {} : spec.options;
  if (!isRecord(own)) throw new PlotSpecError('bad-spec', '`options` must be an object');
  if (spec.preset === undefined) {
    return { data, options: own, marks: /** @type {PlotMarkSpec[]} */ (spec.marks), grid: 'y' };
  }
  const p = spec.preset;
  if (!isRecord(p)) throw new PlotSpecError('bad-spec', '`preset` must be an object');
  if (!allowed(PLOT_PRESETS, p.type)) {
    throw new PlotSpecError('unknown-preset', `unknown preset ${JSON.stringify(p.type)}`);
  }
  if (spec.marks !== undefined) {
    throw new PlotSpecError('bad-spec', 'A chart takes `marks` or a `preset`, not both');
  }
  const rows = rowsOf(data, p.data, `The ${p.type} preset`);
  const width = [env.width, own.width].find((w) => finite(w) && /** @type {number} */ (w) > 0);
  const expanded = PRESETS[/** @type {keyof typeof PRESETS} */ (p.type)](
    p,
    rows,
    own,
    /** @type {number | undefined} */ (width),
  );
  return { data, ...expanded };
}

// ---- drawing ----------------------------------------------------------------

/**
 * @param {PlotModule} Plot
 * @param {string} name
 * @returns {(...args: unknown[]) => unknown}
 */
function fn(Plot, name) {
  const f = Plot[name];
  if (typeof f !== 'function') {
    throw new PlotSpecError('bad-spec', `This Plot has no ${name}`);
  }
  return /** @type {(...args: unknown[]) => unknown} */ (f);
}

/**
 * The height `spec` draws at, known before Plot loads, so a page can hold the
 * chart's place: the spec's own `options.height`, a row per bar for `barsH`,
 * or the default. A spec too broken to read takes the default.
 * @param {unknown} spec
 * @returns {number}
 */
export function plotHeight(spec) {
  if (!isRecord(spec)) return PLOT_DEFAULT_HEIGHT;
  const own = isRecord(spec.options) ? spec.options.height : undefined;
  if (finite(own) && /** @type {number} */ (own) > 0) return /** @type {number} */ (own);
  const p = spec.preset;
  if (isRecord(p) && p.type === 'barsH') {
    const data = isRecord(spec.data) ? spec.data : {};
    const rows = Array.isArray(p.data)
      ? p.data
      : typeof p.data === 'string' && Array.isArray(data[p.data])
        ? /** @type {unknown[]} */ (data[p.data])
        : [];
    return Math.max(120, rows.length * BAR_ROW + BAR_FRAME);
  }
  return PLOT_DEFAULT_HEIGHT;
}

/**
 * Set one style property, where the element has a style to set it on.
 * @param {unknown} el
 * @param {string} key
 * @param {string | null} value null removes it.
 */
function setStyle(el, key, value) {
  const style = /** @type {{ style?: CSSStyleDeclaration }} */ (el).style;
  if (!style) return;
  if (value === null) style.removeProperty(key);
  else style.setProperty(key, value);
}

/**
 * Year ticks: when every x value the marks read (or the x domain) is a year,
 * x ticks and every tip's x read "2005", not "2,005", unless the spec sets
 * its own x `tickFormat`; and, unless it sets its own x `ticks` or
 * `interval`, the ticks are whole years, every `yearStep` years, so Plot's
 * own half-year ticks never print one year twice.
 * @param {Record<string, unknown>} options
 * @param {ReturnType<typeof checkPlotSpec>} marks
 * @param {unknown} width
 */
function yearAxis(options, marks, width) {
  const x = isRecord(options.x) ? options.x : {};
  if (x.type !== undefined) return;
  const domain = Array.isArray(x.domain) ? x.domain : [];
  const xs = [...domain];
  for (const m of marks) {
    const field = m.options.x;
    if (typeof field === 'string') for (const r of m.data) xs.push(get(r, field));
  }
  if (!yearLike(xs)) return;
  /** @type {Record<string, unknown>} */
  const next = { ...x };
  if (x.ticks === undefined && x.interval === undefined) {
    const years = /** @type {number[]} */ (domain.length === 2 ? domain : xs);
    const lo = Math.min(...years);
    const hi = Math.max(...years);
    const named = typeof x.tickFormat === 'string' ? x.tickFormat : 'd';
    const format = named === 'd' ? String : plotFormat(named);
    const label = (Math.max(format(lo).length, format(hi).length) + 2) * CH;
    const step = yearStep(hi - lo, plotWidthOf(options, width), label);
    /** @type {number[]} */
    const ticks = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
    next.ticks = ticks.length > 0 ? ticks : [lo];
  }
  if (x.tickFormat === undefined) {
    next.tickFormat = 'd';
    for (const m of marks) {
      if (m.mark !== 'tip' || typeof m.options.x !== 'string') continue;
      const format = isRecord(m.options.format) ? m.options.format : {};
      if (format.x === undefined) m.options = { ...m.options, format: { ...format, x: 'd' } };
    }
  }
  options.x = next;
}

/**
 * The fewest years between two ticks, 1, 2 or 5 times a power of ten, that
 * keeps a tick's label clear of the next across `plotWidth` px.
 * @param {number} span Years from the first to the last.
 * @param {number} plotWidth
 * @param {number} label A tick label's px, with two glyphs of gap.
 */
function yearStep(span, plotWidth, label) {
  for (let mag = 1; ; mag *= 10) {
    for (const k of [1, 2, 5]) {
      const step = k * mag;
      if (span <= 0 || plotWidth <= 0 || (step / span) * plotWidth >= label) return step;
    }
  }
}

/**
 * The px between the plot's left and right margins at `width`, else at Plot's
 * default width: the spec's margins, else Plot's 40 and 20.
 * @param {Record<string, unknown>} options
 * @param {unknown} width
 */
function plotWidthOf(options, width) {
  const w = finite(width) ? /** @type {number} */ (width) : PLOT_DEFAULT_WIDTH;
  const margin = (/** @type {unknown} */ m, /** @type {number} */ d) =>
    /** @type {number} */ (finite(m) ? m : finite(options.margin) ? options.margin : d);
  return w - margin(options.marginLeft, 40) - margin(options.marginRight, 20);
}

/**
 * Below `NARROW`, an explicit numeric x `ticks` array keeps every nth tick,
 * starting with the first, so no two labels overlap: each label is its
 * formatted length in `CH` glyphs plus two glyphs of gap, so neighbours read
 * as two labels, against the pixels between the closest two ticks across the
 * plot's width.
 * @param {Record<string, unknown>} options
 * @param {ReturnType<typeof checkPlotSpec>} marks
 * @param {unknown} width
 */
function thinTicks(options, marks, width) {
  if (!(finite(width) && /** @type {number} */ (width) < NARROW)) return;
  const x = isRecord(options.x) ? options.x : {};
  const ticks = Array.isArray(x.ticks) ? [...x.ticks].sort((a, b) => a - b) : [];
  if (ticks.length < 2 || !ticks.every(finite)) return;
  const named = typeof x.tickFormat === 'string' ? x.tickFormat : 'comma';
  const format = named === 'd' ? String : plotFormat(named);
  const label = Math.max(...ticks.map((t) => format(t).length)) * CH + 2 * CH;
  /** @type {unknown[]} */
  const xs = Array.isArray(x.domain) ? [...x.domain] : [];
  if (xs.length === 0) {
    for (const m of marks) {
      const field = m.options.x;
      if (typeof field === 'string') for (const r of m.data) xs.push(get(r, field));
    }
  }
  const all = [...ticks, ...xs.filter(finite).map(Number)];
  const span = Math.max(...all) - Math.min(...all);
  const plotWidth = plotWidthOf(options, width);
  const gap = Math.min(...ticks.slice(1).map((t, i) => t - /** @type {number} */ (ticks[i])));
  if (!(span > 0 && gap > 0 && plotWidth > 0)) return;
  const step = Math.ceil(label / ((gap / span) * plotWidth));
  if (step > 1) options.x = { ...x, ticks: ticks.filter((_, i) => i % step === 0) };
}

/**
 * The chart `spec` describes, drawn by `Plot`. Throws a `PlotSpecError`, having
 * called no Plot function, when the spec names anything outside the
 * allowlists, a format or reducer it does not know, or a `data` key it does
 * not carry. It draws `plotHeight(spec)` tall and `env.width` wide (else the
 * spec's width), and its SVG fills its container's width at that height.
 * `env.document` is the document Plot draws into, for a page with none.
 * @param {PlotModule} Plot
 * @param {PlotSpec} spec
 * @param {{ document?: unknown, width?: number }} [env]
 * @returns {Element}
 */
export function buildPlot(Plot, spec, env = {}) {
  const expanded = expandPreset(spec, env.width === undefined ? {} : { width: env.width });
  // Every function is found, and every name and format checked, before any
  // Plot function is called.
  const checked = checkPlotSpec(expanded);
  const own = { ...expanded.options };
  const width = finite(env.width) && /** @type {number} */ (env.width) > 0 ? env.width : own.width;
  yearAxis(own, checked, width);
  thinTicks(own, checked, width);
  const steps = checked.map((m) => ({
    m,
    mark: fn(Plot, m.mark),
    transform: m.transform ? fn(Plot, m.transform) : undefined,
    pointer: m.pointer ? fn(Plot, m.pointer) : undefined,
  }));
  const height = plotHeight(spec);
  const options = houseOptions({ ...own, height, ...(width === undefined ? {} : { width }) });
  const grid = houseGrid(Plot, own, expanded.grid);
  const plot = fn(Plot, 'plot');
  const marks = steps.map(({ m, mark, transform, pointer }) => {
    let options = /** @type {unknown} */ (m.options);
    if (transform) options = m.outputs ? transform(m.outputs, options) : transform(options);
    if (pointer) options = pointer(options);
    return mark(m.data, options);
  });
  const doc = env.document === undefined ? {} : { document: env.document };
  const figure = /** @type {Element} */ (
    plot({ ...options, ...doc, marks: [...grid.map((g) => g()), ...marks] })
  );
  // On each SVG itself: Plot's own sheet sets `--plot-background` there, so
  // a value inherited from a parent would lose to it.
  const custom = Object.entries(houseStyle(own.style).custom);
  const svgs =
    figure.tagName.toLowerCase() === 'svg' ? [figure] : [...figure.querySelectorAll('svg')];
  for (const svg of svgs) for (const [k, v] of custom) setStyle(svg, k, v);
  // The chart itself, after any legend: full width at its own height, so a
  // static page that never redraws still fills its column without growing.
  const chart = svgs.at(-1);
  if (chart) {
    setStyle(chart, 'width', '100%');
    setStyle(chart, 'height', `${height}px`);
  }
  return figure;
}

/** Whether a chart only works once a page runs it: a tip follows the pointer.
 *  @param {PlotSpec} spec */
export function hasPointer(spec) {
  if (!isRecord(spec)) return false;
  if (isRecord(spec.preset)) return spec.preset.type !== 'barsH';
  return (
    Array.isArray(spec.marks) && spec.marks.some((m) => isRecord(m) && m.pointer !== undefined)
  );
}

/**
 * What a drawn element was last drawn from, and the observer that redraws it.
 * @type {WeakMap<Element, { Plot: PlotModule, spec: PlotSpec, width: number, frame: boolean }>}
 */
const drawn = /* @__PURE__ */ new WeakMap();

/** @param {Element} element */
const widthOf = (element) => Math.round(/** @type {HTMLElement} */ (element).clientWidth || 0);

/**
 * @param {PlotModule} Plot
 * @param {Element} element
 * @param {PlotSpec} spec
 * @param {number} width
 * @returns {Element | null}
 */
function draw(Plot, element, spec, width) {
  try {
    const figure = buildPlot(Plot, spec, {
      document: element.ownerDocument,
      ...(width > 0 ? { width } : {}),
    });
    setStyle(element, 'height', `${plotHeight(spec)}px`);
    element.replaceChildren(figure);
    return figure;
  } catch (err) {
    const box = element.ownerDocument.createElement('div');
    box.className = 'plot-spec-error';
    box.setAttribute('role', 'alert');
    box.textContent =
      err instanceof PlotSpecError
        ? err.message
        : `Plot could not draw this chart: ${err instanceof Error ? err.message : String(err)}`;
    // The box takes its own height; a refused chart is the thing to notice.
    setStyle(element, 'height', null);
    element.replaceChildren(box);
    return null;
  }
}

/**
 * Draw `spec` into `element`, replacing what it held: the chart, or an error
 * box (`.plot-spec-error`) saying why it could not be drawn. The sites call
 * it to draw a chart in the browser, and the board makes the same call.
 *
 * The element is held at `plotHeight(spec)` px, and the chart is drawn at the
 * element's width, then drawn again whenever that width changes (a
 * ResizeObserver, at most once a frame). Only the width changes: the height,
 * the margins and the 13px text stay as the spec gives them, so a narrow
 * column gets a narrower chart rather than a smaller one. Returns the chart,
 * or null.
 * @param {PlotModule} Plot
 * @param {Element} element
 * @param {PlotSpec} spec
 * @returns {Element | null}
 */
export function renderPlot(Plot, element, spec) {
  const width = widthOf(element);
  const figure = draw(Plot, element, spec, width);
  const known = drawn.get(element);
  if (known) {
    Object.assign(known, { Plot, spec, width });
    return figure;
  }
  const view = element.ownerDocument.defaultView;
  const Observer = view?.ResizeObserver;
  if (!view || typeof Observer !== 'function') return figure;
  const state = { Plot, spec, width, frame: false };
  drawn.set(element, state);
  const observer = new Observer(() => {
    if (!element.isConnected) {
      observer.disconnect();
      drawn.delete(element);
      return;
    }
    if (state.frame) return;
    state.frame = true;
    view.requestAnimationFrame(() => {
      state.frame = false;
      const now = widthOf(element);
      if (now > 0 && now !== state.width) {
        state.width = now;
        draw(state.Plot, element, state.spec, now);
      }
    });
  });
  observer.observe(element);
  return figure;
}
