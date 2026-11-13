/**
 * The JSX runtime every component bundle carries (`cw/jsx-runtime`), and the
 * `render` its entry calls on the doc page.
 *
 * A component is a plain ES module (design decision 10):
 *
 *   export default function mount(el, props, state?) { … return cleanup? }
 *
 * so one file runs in a doc, on an Astro page and on SF Works with no
 * framework. JSX, in the doc's tag and in a component's own `.tsx`, compiles
 * to `jsx()` calls that build DOM at once: `<b>{name}</b>` is an element a
 * component can `append`. A string tag (`<div>`, `<wa-carousel>`) is made with
 * `document.createElement`. A function tag gets a `<div class="mdx-component">`
 * of its own and is called with its props, its children already built as DOM
 * nodes in `props.children`, so a carousel can put each child in a slide. A
 * built-in (`<PlotChart>`) is drawn by the page through `api.builtins`.
 *
 * Text only ever reaches the DOM as a text node. Nothing here sets
 * `innerHTML` or evaluates a string.
 */

export const Fragment: unique symbol = Symbol.for('cw.fragment');

/** A tag the page draws itself. */
export interface CwBuiltin {
  readonly $$builtin: string;
}

/** A component's default export. It may return a cleanup; one that returns
 *  nothing is typed `void`, which is why the union names it. */
export type MountFn = (
  el: HTMLElement,
  props: Record<string, unknown>,
  state?: unknown,
  // biome-ignore lint/suspicious/noConfusingVoidType: an author's mount that returns nothing is a () => void, and must be assignable
) => (() => void) | void;

/** What the page hands a bundle's entry. */
export interface ComponentHostApi {
  builtins: Record<string, (el: HTMLElement, props: Record<string, unknown>) => void>;
}

/** The render in progress: where a component's cleanup goes, and the page's
 *  built-ins. JSX built after `render` returns (in an event handler) has
 *  neither, so its components' cleanups are the component's own business. */
let current: { api: ComponentHostApi; cleanups: Array<() => void> } | null = null;

export function builtin(name: string): CwBuiltin {
  return { $$builtin: name };
}

const isBuiltin = (v: unknown): v is CwBuiltin =>
  typeof v === 'object' && v !== null && typeof (v as CwBuiltin).$$builtin === 'string';

export function jsx(type: unknown, props: Record<string, unknown> | null): Node {
  const p = props ?? {};
  const children = nodesOf(p.children);
  if (type === Fragment) {
    const frag = document.createDocumentFragment();
    frag.append(...children);
    return frag;
  }
  if (isBuiltin(type)) {
    const el = document.createElement('div');
    el.className = 'mdx-component mdx-builtin';
    const draw = current?.api.builtins[type.$$builtin];
    if (draw) draw(el, p);
    else el.textContent = `<${type.$$builtin}> is drawn only in a doc`;
    return el;
  }
  if (typeof type === 'function') {
    const el = document.createElement('div');
    el.className = 'mdx-component';
    const out = (type as MountFn)(el, { ...p, children });
    if (typeof out === 'function') current?.cleanups.push(out);
    return el;
  }
  const el = document.createElement(String(type));
  for (const [k, value] of Object.entries(p)) setProp(el, k, value);
  el.append(...children);
  return el;
}
export const jsxs = jsx;
export const jsxDEV = jsx;

/**
 * Draw `make()` into `host`, replacing what it held. Returns the cleanup that
 * calls every component's own.
 */
export function render(host: HTMLElement, api: ComponentHostApi, make: () => unknown): () => void {
  const outer = current;
  const cleanups: Array<() => void> = [];
  current = { api, cleanups };
  try {
    host.replaceChildren(...nodesOf(make()));
  } finally {
    current = outer;
  }
  return () => {
    for (const f of cleanups.splice(0)) {
      try {
        f();
      } catch (err) {
        console.error('[component] cleanup threw', err);
      }
    }
  };
}

function nodesOf(v: unknown): Node[] {
  if (v === null || v === undefined || typeof v === 'boolean') return [];
  if (Array.isArray(v)) return v.flatMap(nodesOf);
  if (v instanceof Node) return [v];
  return [document.createTextNode(String(v))];
}

function setProp(el: HTMLElement, key: string, value: unknown): void {
  if (key === 'children' || key === 'key' || value === null || value === undefined) return;
  if (key === 'innerHTML' || key === 'outerHTML' || key === 'dangerouslySetInnerHTML') return;
  if (key === 'ref' && typeof value === 'function') {
    value(el);
    return;
  }
  if (/^on[A-Z]/.test(key) && typeof value === 'function') {
    el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    return;
  }
  const name = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key;
  if (name === 'style' && typeof value === 'object') {
    Object.assign(el.style, value);
    return;
  }
  if (value === false) return;
  if (value === true) el.setAttribute(name, '');
  else if (typeof value === 'string' || typeof value === 'number')
    el.setAttribute(name, String(value));
  // An object or array goes to a property of that name: a custom element
  // reads its data there.
  else (el as unknown as Record<string, unknown>)[name] = value;
}
