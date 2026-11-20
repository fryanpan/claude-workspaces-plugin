import type { ReadyLayer } from './draw-layers.ts';
/**
 * The map's GeoJSON layers between their props and the renderer: it fetches
 * a `url` layer's file once per map, judges each layer's data in declared
 * order against the map's caps, and draws the list under the map that
 * switches each layer on and off.
 *
 * A layer whose file is still coming says "loading" in its row; one whose
 * file fails, or whose data breaks a rule, says why there and draws nothing,
 * and every other layer still draws. Each row carries its state
 * (`data-state`: drawn, off, loading, failed) and its feature count
 * (`data-features`), which is what a test reads.
 */
import { type MapLayer, emptyBudget, readLayerData } from './layers.ts';

type Fetched = { json: unknown } | { error: string } | 'pending';

/** What the map draws now: the layers ready, which are off, and a key that
 *  changes when what they frame changes. */
export interface LayersNow {
  ready: ReadyLayer[];
  hidden: ReadonlySet<string>;
  frame: string;
}

export class LayerControl {
  private layers: MapLayer[] = [];
  private readonly fetched = new Map<string, Fetched>();
  private readonly hidden = new Set<string>();
  /** Ids seen before, so a layer's `visible` applies once, not on every
   *  redraw over a reader's own choice. */
  private readonly seen = new Set<string>();
  private now: LayersNow = { ready: [], hidden: this.hidden, frame: '' };
  private gone = false;

  constructor(
    private readonly list: HTMLElement,
    /** Called when the ready layers change. */
    private readonly changed: (now: LayersNow) => void,
    /** Called when the reader switches a layer. */
    private readonly toggled: (id: string, on: boolean) => void,
    private readonly fetchJson: (url: string) => Promise<unknown> = defaultFetch,
  ) {}

  /** Take a new set of layers (a redraw of the props or the state). */
  update(layers: MapLayer[], showList: boolean): void {
    this.layers = layers;
    for (const l of layers) {
      if (!this.seen.has(l.id)) {
        this.seen.add(l.id);
        if (!l.visible) this.hidden.add(l.id);
      }
      if ('url' in l.source && !this.fetched.has(l.source.url)) this.load(l.source.url);
    }
    this.list.hidden = !showList || layers.length === 0;
    this.pass();
  }

  current(): LayersNow {
    return this.now;
  }

  remove(): void {
    this.gone = true;
  }

  private load(url: string): void {
    this.fetched.set(url, 'pending');
    this.fetchJson(url).then(
      (json) => this.settle(url, { json }),
      (err: unknown) =>
        this.settle(url, { error: err instanceof Error ? err.message : String(err) }),
    );
  }

  private settle(url: string, got: Fetched): void {
    this.fetched.set(url, got);
    if (!this.gone) this.pass();
  }

  /** Judge every layer whose data is here, in order, and redraw the list. */
  private pass(): void {
    const budget = emptyBudget();
    const ready: ReadyLayer[] = [];
    const rows: HTMLElement[] = [];
    const frame: string[] = [];
    for (const layer of this.layers) {
      let got: Fetched;
      if ('url' in layer.source) got = this.fetched.get(layer.source.url) ?? 'pending';
      else got = { json: layer.source.data };
      let state: 'drawn' | 'off' | 'loading' | 'failed';
      let words = '';
      let features = 0;
      if (got === 'pending') state = 'loading';
      else if ('error' in got) {
        state = 'failed';
        words = `could not load: ${got.error}`;
      } else {
        const read = readLayerData(layer, got.json, budget);
        if (read.ok) {
          ready.push({ layer, data: read.value });
          features =
            read.value.kind === 'heat' ? read.value.points.length : read.value.features.length;
          state = this.hidden.has(layer.id) ? 'off' : 'drawn';
          frame.push(`${layer.id}:${features}`);
        } else {
          state = 'failed';
          words = read.error;
        }
      }
      rows.push(this.rowOf(layer, state, features, words));
    }
    this.list.replaceChildren(...rows);
    this.now = { ready, hidden: this.hidden, frame: frame.join('|') };
    this.changed(this.now);
  }

  private rowOf(layer: MapLayer, state: string, features: number, words: string): HTMLElement {
    const doc = this.list.ownerDocument;
    const li = doc.createElement('li');
    li.dataset.layer = layer.id;
    li.dataset.state = state;
    li.dataset.features = String(features);
    const label = doc.createElement('label');
    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.checked = !this.hidden.has(layer.id);
    box.disabled = state === 'loading' || state === 'failed';
    box.addEventListener('change', () => {
      if (box.checked) this.hidden.delete(layer.id);
      else this.hidden.add(layer.id);
      li.dataset.state = box.checked ? 'drawn' : 'off';
      this.toggled(layer.id, box.checked);
    });
    const swatch = doc.createElement('span');
    swatch.className = `cw-map-swatch is-${layer.type}`;
    const color =
      layer.type === 'line'
        ? layer.color
        : layer.type === 'polygon'
          ? layer.fill
          : (layer.colors.at(-1) ?? '#ef4444');
    swatch.style.setProperty('background-color', color);
    const name = doc.createElement('span');
    name.textContent = layer.name;
    label.append(box, swatch, name);
    li.append(label);
    if (state === 'loading' || words) {
      const why = doc.createElement('span');
      why.className = 'cw-map-layer-why';
      why.textContent = state === 'loading' ? 'loading' : words;
      li.append(why);
    }
    return li;
  }
}

async function defaultFetch(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
