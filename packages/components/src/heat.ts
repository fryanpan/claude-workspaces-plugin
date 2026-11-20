/**
 * A heatmap as a Leaflet layer: one canvas the size of the map, redrawn
 * when the view settles. Each point stamps a soft disc of its weight into
 * the canvas's alpha, and the alpha is then coloured along the layer's ramp
 * (the method of simpleheat, which leaflet.heat draws with, written here so
 * the package takes no plugin that patches the global `L`).
 *
 * Points are first binned into cells half a radius wide, so a redraw stamps
 * at most one disc per cell: tens of thousands of points cost a pass over
 * the array and a few thousand stamps, not one stamp each. The canvas takes
 * no pointer events, so a tap goes through to the paths beneath.
 */
import L from 'leaflet';
import type { HeatPoint, HeatmapLayer } from './layers.ts';

/** A 256-step lookup, RGBA per step, from `colors` cold to hot. */
function rampOf(doc: Document, colors: readonly string[]): Uint8ClampedArray | null {
  const ctx = doc.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  ctx.canvas.width = 256;
  ctx.canvas.height = 1;
  const g = ctx.createLinearGradient(0, 0, 256, 0);
  const last = Math.max(1, colors.length - 1);
  colors.forEach((c, i) => {
    try {
      g.addColorStop(i / last, c);
    } catch {
      // A colour the canvas will not parse leaves a gap in the ramp.
    }
  });
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 1);
  return ctx.getImageData(0, 0, 256, 1).data;
}

/** A disc of `radius` with a soft edge, in black with full alpha at its
 *  centre: stamped with `globalAlpha` set to a cell's weight. */
function brushOf(doc: Document, radius: number): HTMLCanvasElement {
  const blur = radius / 2;
  const r = radius + blur;
  const c = doc.createElement('canvas');
  c.width = c.height = r * 2;
  const ctx = c.getContext('2d');
  if (ctx) {
    // The disc is drawn off the canvas and only its shadow lands on it.
    ctx.shadowOffsetX = ctx.shadowOffsetY = r * 2;
    ctx.shadowBlur = blur;
    ctx.shadowColor = 'black';
    ctx.beginPath();
    ctx.arc(-r, -r, radius, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.fill();
  }
  return c;
}

export class HeatLayer extends L.Layer {
  private canvas: HTMLCanvasElement | null = null;
  private brush: HTMLCanvasElement | null = null;
  private ramp: Uint8ClampedArray | null = null;
  /** Cells stamped on the last redraw: what a test reads off the slot. */
  stamped = 0;

  constructor(
    private readonly spec: HeatmapLayer,
    private readonly points: readonly HeatPoint[],
    private readonly paneName: string,
  ) {
    super({ pane: paneName });
  }

  override onAdd(map: L.Map): this {
    const doc = map.getContainer().ownerDocument;
    const canvas = doc.createElement('canvas');
    canvas.className = 'cw-map-heat leaflet-zoom-hide';
    canvas.style.pointerEvents = 'none';
    canvas.style.opacity = String(this.spec.opacity);
    canvas.dataset.layer = this.spec.id;
    this.canvas = canvas;
    this.brush = brushOf(doc, this.spec.radius);
    this.ramp = rampOf(doc, this.spec.colors);
    map.getPane(this.paneName)?.appendChild(canvas);
    map.on('moveend resize zoomend viewreset', this.redraw, this);
    this.redraw();
    return this;
  }

  override onRemove(map: L.Map): this {
    map.off('moveend resize zoomend viewreset', this.redraw, this);
    this.canvas?.remove();
    this.canvas = null;
    return this;
  }

  /** Draw the points the view holds, binned into cells. */
  redraw(): void {
    const map = this._map;
    const canvas = this.canvas;
    const ctx = canvas?.getContext('2d');
    if (!map || !canvas || !ctx || !this.brush || !this.ramp) return;
    const size = map.getSize();
    canvas.width = size.x;
    canvas.height = size.y;
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));

    const r = this.spec.radius;
    const reach = r * 1.5;
    const cell = Math.max(1, r / 2);
    const cols = Math.ceil((size.x + reach * 2) / cell);
    const cells = new Map<number, { x: number; y: number; w: number }>();
    for (const p of this.points) {
      if (p.weight <= 0) continue;
      const at = map.latLngToContainerPoint([p.lat, p.lng]);
      if (at.x < -reach || at.y < -reach || at.x > size.x + reach || at.y > size.y + reach) {
        continue;
      }
      const key = Math.floor((at.y + reach) / cell) * cols + Math.floor((at.x + reach) / cell);
      const held = cells.get(key);
      if (held) {
        // The cell's disc sits at its points' weighted centre.
        const w = held.w + p.weight;
        held.x += ((at.x - held.x) * p.weight) / w;
        held.y += ((at.y - held.y) * p.weight) / w;
        held.w = w;
      } else {
        cells.set(key, { x: at.x, y: at.y, w: p.weight });
      }
    }
    let max = 0;
    for (const c of cells.values()) max = Math.max(max, c.w);
    ctx.clearRect(0, 0, size.x, size.y);
    this.stamped = cells.size;
    if (max === 0) return;
    const half = this.brush.width / 2;
    for (const c of cells.values()) {
      ctx.globalAlpha = Math.min(1, Math.max(0.05, (c.w / max) * this.spec.intensity));
      ctx.drawImage(this.brush, c.x - half, c.y - half);
    }
    ctx.globalAlpha = 1;
    const image = ctx.getImageData(0, 0, size.x, size.y);
    const px = image.data;
    for (let i = 3; i < px.length; i += 4) {
      const a = px[i] ?? 0;
      if (a === 0) continue;
      const j = a * 4;
      px[i - 3] = this.ramp[j] ?? 0;
      px[i - 2] = this.ramp[j + 1] ?? 0;
      px[i - 1] = this.ramp[j + 2] ?? 0;
    }
    ctx.putImageData(image, 0, 0);
  }
}
