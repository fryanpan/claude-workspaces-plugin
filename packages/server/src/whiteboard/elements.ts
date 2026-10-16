/**
 * The agent's shapes, turned into whole Excalidraw elements and back.
 *
 * An agent draws in a small vocabulary — a box, an ellipse, an arrow, a line
 * of text — and the page renders Excalidraw's full element JSON. Every field
 * the canvas reads is built here (seed, versionNonce, roundness, the bound
 * text of a labelled box, an arrow's bindings), so a page shows an agent's
 * drawing exactly as it shows a person's, with nothing to repair on load.
 *
 * Pure: no Y.Doc and no clock beyond what is passed in. `whiteboard/scene.ts`
 * reads the stored elements, calls this, and writes what it returns.
 */
import type { SceneElement, WhiteboardShape } from '@claude-workspaces/core/whiteboard-scene';
import { generateKeyBetween } from 'fractional-indexing';

/** The four kinds an agent may draw. */
export const DRAWABLE_KINDS = ['box', 'ellipse', 'arrow', 'text'] as const;
export type DrawableKind = (typeof DRAWABLE_KINDS)[number];

/** One shape as the verb receives it, after validation. */
export interface ShapeInput {
  id?: string;
  kind: DrawableKind;
  x: number;
  y: number;
  w?: number;
  h?: number;
  text?: string;
  from?: string;
  to?: string;
}

/** Most shapes one call may carry. */
export const MAX_SHAPES = 200;
/** Longest text one shape may carry. */
export const MAX_SHAPE_TEXT = 2000;
/** How far from the origin a coordinate may sit, in canvas units. */
const MAX_COORD = 1_000_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const STROKE = '#1e1e1e';
const FONT_SIZE = 20;
/** Excalifont, Excalidraw's default hand-drawn face. */
const FONT_FAMILY = 5;
const LINE_HEIGHT = 1.25;
const DEFAULT_SIZE: Record<DrawableKind, { w: number; h: number }> = {
  box: { w: 160, h: 80 },
  ellipse: { w: 140, h: 90 },
  arrow: { w: 120, h: 0 },
  text: { w: 0, h: 0 },
};

/**
 * Validate a `shapes` body field, or say which entry and which field is
 * wrong. Nothing is coerced: a numeric id or a string coordinate is a caller
 * bug, and guessing would draw somewhere the caller did not mean.
 */
export function parseShapes(
  raw: unknown,
): { ok: true; shapes: ShapeInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'shapes must be an array' };
  if (raw.length > MAX_SHAPES) {
    return { ok: false, error: `shapes must hold at most ${MAX_SHAPES} entries` };
  }
  const shapes: ShapeInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] as Record<string, unknown> | null;
    const at = `shapes[${i}]`;
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      return { ok: false, error: `${at} must be an object` };
    }
    if (!DRAWABLE_KINDS.includes(s.kind as DrawableKind)) {
      return { ok: false, error: `${at}.kind must be one of ${DRAWABLE_KINDS.join(', ')}` };
    }
    const shape: ShapeInput = { kind: s.kind as DrawableKind, x: 0, y: 0 };
    for (const f of ['x', 'y'] as const) {
      const v = s[f];
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_COORD) {
        return { ok: false, error: `${at}.${f} must be a number within ±${MAX_COORD}` };
      }
      shape[f] = v;
    }
    for (const f of ['w', 'h'] as const) {
      const v = s[f];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_COORD) {
        return { ok: false, error: `${at}.${f} must be a number within ±${MAX_COORD}` };
      }
      shape[f] = v;
    }
    for (const f of ['id', 'from', 'to'] as const) {
      const v = s[f];
      if (v === undefined) continue;
      if (typeof v !== 'string' || !ID_RE.test(v)) {
        return { ok: false, error: `${at}.${f} must be 1-64 letters, digits, - or _` };
      }
      shape[f] = v;
    }
    if (s.text !== undefined) {
      if (typeof s.text !== 'string' || s.text.length > MAX_SHAPE_TEXT) {
        return { ok: false, error: `${at}.text must be a string of at most ${MAX_SHAPE_TEXT}` };
      }
      shape.text = s.text;
    }
    if (shape.kind === 'text' && !shape.text) {
      return { ok: false, error: `${at}.text is required for a text shape` };
    }
    shapes.push(shape);
  }
  return { ok: true, shapes };
}

/** What building needs beyond the shapes: the board as it stands, and randomness. */
export interface BuildContext {
  /** Every stored element, deleted ones included, keyed by id. */
  existing: ReadonlyMap<string, SceneElement>;
  /** A fresh id for a shape that names none. */
  newId: () => string;
  /** A random 31-bit integer, for seed and versionNonce. */
  random: () => number;
  now: number;
}

/** The text of a labelled shape is its own element, under this id. */
export const labelIdOf = (id: string): string => `${id}-label`;

function measure(text: string): { w: number; h: number } {
  const lines = text.split('\n');
  const longest = Math.max(...lines.map((l) => l.length), 1);
  return {
    w: Math.ceil(longest * FONT_SIZE * 0.55),
    h: Math.ceil(lines.length * FONT_SIZE * LINE_HEIGHT),
  };
}

function base(
  ctx: BuildContext,
  prior: SceneElement | undefined,
  fields: Record<string, unknown> & { id: string; type: string },
): SceneElement {
  return {
    angle: 0,
    strokeColor: STROKE,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    // A replaced element keeps its seed, so its hand-drawn wobble does not
    // jump when only its words change.
    seed: typeof prior?.seed === 'number' ? prior.seed : ctx.random(),
    isDeleted: false,
    boundElements: null,
    updated: ctx.now,
    link: null,
    locked: false,
    index: prior?.index ?? null,
    ...fields,
    version: (prior?.version ?? 0) + 1,
    versionNonce: ctx.random(),
  };
}

function textElement(
  ctx: BuildContext,
  id: string,
  text: string,
  at: { x: number; y: number },
  containerId: string | null,
): SceneElement {
  const size = measure(text);
  return base(ctx, ctx.existing.get(id), {
    id,
    type: 'text',
    x: at.x,
    y: at.y,
    width: size.w,
    height: size.h,
    text,
    originalText: text,
    fontSize: FONT_SIZE,
    fontFamily: FONT_FAMILY,
    textAlign: containerId ? 'center' : 'left',
    verticalAlign: containerId ? 'middle' : 'top',
    containerId,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
  });
}

/** Where a straight line from a box's centre towards a point leaves the box. */
function edgeToward(
  box: Rect,
  target: { x: number; y: number },
  gap: number,
): { x: number; y: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : (box.w / 2 + gap) / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : (box.h / 2 + gap) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const rectOf = (el: SceneElement | undefined): Rect | undefined =>
  el && !el.isDeleted && typeof el.x === 'number' && typeof el.y === 'number'
    ? { x: el.x, y: el.y, w: Number(el.width) || 0, h: Number(el.height) || 0 }
    : undefined;

type BoundRef = { id: string; type: 'text' | 'arrow' };

function boundRefs(el: SceneElement | undefined): BoundRef[] {
  const raw = el?.boundElements;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is BoundRef => !!r && typeof r === 'object' && typeof (r as BoundRef).id === 'string',
  );
}

/**
 * Build every element a list of shapes writes, ordered so that each one's
 * index sorts after the board's current top. A labelled box or ellipse
 * produces two elements, the container and its text; an arrow joined to two
 * shapes also rewrites those shapes' `boundElements` so moving one drags the
 * arrow, as it would for an arrow a person drew.
 */
export function buildElements(shapes: readonly ShapeInput[], ctx: BuildContext): SceneElement[] {
  const out = new Map<string, SceneElement>();
  const current = (id: string): SceneElement | undefined => out.get(id) ?? ctx.existing.get(id);

  for (const shape of shapes) {
    const id = shape.id ?? ctx.newId();
    const prior = ctx.existing.get(id);
    const size = DEFAULT_SIZE[shape.kind];
    if (shape.kind === 'text') {
      out.set(id, textElement(ctx, id, shape.text ?? '', shape, null));
      continue;
    }
    if (shape.kind === 'arrow') {
      const fromRect = shape.from ? rectOf(current(shape.from)) : undefined;
      const toRect = shape.to ? rectOf(current(shape.to)) : undefined;
      let start = { x: shape.x, y: shape.y };
      let end = { x: shape.x + (shape.w ?? size.w), y: shape.y + (shape.h ?? size.h) };
      const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
      if (fromRect) start = edgeToward(fromRect, toRect ? centre(toRect) : end, 4);
      if (toRect) end = edgeToward(toRect, fromRect ? centre(fromRect) : start, 4);
      const binding = (elementId: string | undefined, rect: Rect | undefined) =>
        elementId && rect ? { elementId, focus: 0, gap: 4 } : null;
      out.set(
        id,
        base(ctx, prior, {
          id,
          type: 'arrow',
          x: start.x,
          y: start.y,
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
          roundness: { type: 2 },
          points: [
            [0, 0],
            [end.x - start.x, end.y - start.y],
          ],
          lastCommittedPoint: null,
          startBinding: binding(shape.from, fromRect),
          endBinding: binding(shape.to, toRect),
          startArrowhead: null,
          endArrowhead: 'arrow',
          elbowed: false,
        }),
      );
      for (const end of [shape.from, shape.to]) {
        const target = end ? current(end) : undefined;
        if (!end || !target || !rectOf(target)) continue;
        const refs = boundRefs(target);
        if (refs.some((r) => r.id === id)) continue;
        const next: SceneElement = {
          ...target,
          boundElements: [...refs, { id, type: 'arrow' }],
          version: target.version + 1,
          versionNonce: ctx.random(),
          updated: ctx.now,
        };
        out.set(end, next);
      }
      continue;
    }
    // A box or an ellipse, with its words as a bound text element.
    const w = Math.max(shape.w ?? size.w, 1);
    const h = Math.max(shape.h ?? size.h, 1);
    const labelId = labelIdOf(id);
    const keptRefs = boundRefs(prior).filter((r) => r.type === 'arrow');
    const priorLabel = ctx.existing.get(labelId);
    const refs: BoundRef[] = shape.text ? [{ id: labelId, type: 'text' }, ...keptRefs] : keptRefs;
    out.set(
      id,
      base(ctx, prior, {
        id,
        type: shape.kind === 'box' ? 'rectangle' : 'ellipse',
        x: shape.x,
        y: shape.y,
        width: w,
        height: h,
        roundness: shape.kind === 'box' ? { type: 3 } : { type: 2 },
        boundElements: refs.length > 0 ? refs : null,
      }),
    );
    if (shape.text) {
      const tsize = measure(shape.text);
      out.set(
        labelId,
        textElement(
          ctx,
          labelId,
          shape.text,
          { x: shape.x + (w - tsize.w) / 2, y: shape.y + (h - tsize.h) / 2 },
          id,
        ),
      );
    } else if (priorLabel && !priorLabel.isDeleted) {
      // The words were taken off: delete the label rather than strand it.
      out.set(labelId, tombstone(priorLabel, ctx));
    }
  }

  // Order: a brand-new element goes on top of everything already there.
  let top: string | null = null;
  for (const el of ctx.existing.values()) {
    if (typeof el.index === 'string' && (top === null || el.index > top)) top = el.index;
  }
  for (const el of out.values()) {
    if (typeof el.index === 'string' && el.index.length > 0) continue;
    top = generateKeyBetween(top, null);
    el.index = top;
  }
  return [...out.values()];
}

/** The deleted copy of an element: a new version, so it beats every older one. */
export function tombstone(
  el: SceneElement,
  ctx: Pick<BuildContext, 'random' | 'now'>,
): SceneElement {
  return {
    ...el,
    isDeleted: true,
    version: el.version + 1,
    versionNonce: ctx.random(),
    updated: ctx.now,
  };
}

const KIND_OF_TYPE: Record<string, string> = {
  rectangle: 'box',
  ellipse: 'ellipse',
  arrow: 'arrow',
  text: 'text',
};

const round = (n: unknown): number => Math.round((Number(n) || 0) * 10) / 10;

/**
 * The board in the agent's vocabulary: one shape per element still on it.
 * A container's bound text is folded into the container's `text` rather than
 * listed twice, so a labelled box an agent wrote reads back as it was sent.
 */
export function toShapes(elements: readonly SceneElement[]): WhiteboardShape[] {
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const shapes: WhiteboardShape[] = [];
  for (const el of live) {
    const containerId = typeof el.containerId === 'string' ? el.containerId : null;
    if (el.type === 'text' && containerId && byId.has(containerId)) continue;
    const shape: WhiteboardShape = {
      id: el.id,
      kind: KIND_OF_TYPE[el.type] ?? el.type,
      x: round(el.x),
      y: round(el.y),
    };
    if (el.type === 'arrow' || el.type === 'line') {
      const pts = Array.isArray(el.points) ? (el.points as unknown[]) : [];
      const last = pts[pts.length - 1];
      if (Array.isArray(last)) {
        shape.w = round(last[0]);
        shape.h = round(last[1]);
      }
      const from = (el.startBinding as { elementId?: unknown } | null)?.elementId;
      const to = (el.endBinding as { elementId?: unknown } | null)?.elementId;
      if (typeof from === 'string') shape.from = from;
      if (typeof to === 'string') shape.to = to;
    } else {
      shape.w = round(el.width);
      shape.h = round(el.height);
    }
    if (el.type === 'text' && typeof el.text === 'string') shape.text = el.text;
    const label = boundRefs(el).find((r) => r.type === 'text');
    const labelEl = label ? byId.get(label.id) : undefined;
    if (labelEl && typeof labelEl.text === 'string') shape.text = labelEl.text;
    shapes.push(shape);
  }
  return shapes;
}
