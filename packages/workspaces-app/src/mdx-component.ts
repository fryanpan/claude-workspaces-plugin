import type { ComponentHostApi, StateHook } from '@claude-workspaces/core/mdx-component-runtime';
import {
  COMPONENT_STATE_ID,
  type OwnedStateHook,
  createStateHook,
} from '@claude-workspaces/core/mdx-component-state';
import {
  type ComponentBuild,
  componentBuildOf,
  componentBuildsMap,
  componentInputs,
} from '@claude-workspaces/core/mdx-components';
/**
 * A component tag in a bound `.mdx` doc, drawn live in the page.
 *
 * The server builds each component tag and files the build in the doc's
 * `componentBuilds` map under a key both sides compute from the same blocks
 * (`core/mdx-components.ts`). This finds the tag's key among the editor's
 * `mdx-flow` blocks, imports the bundle the map names from
 * `…/docs/<id>/components/<hash>.js`, and calls its default export on a host
 * element in the page (design decision 2: no frames). It remounts only when
 * the hash changes, so the map moving for another tag leaves this one alone.
 * A failed rebuild keeps the component that drew and shows why under it.
 *
 * Every component bundle carries its own copy of what it imports, so a
 * custom element (`<wa-carousel>`) can arrive a second time when a tag
 * rebuilds. `customElements.define` throws on a name already defined, so it
 * is wrapped once to skip a name the page already has; the element defined
 * first stays.
 *
 * A tag with an `id` gets that id's live state (`core/mdx-component-state.ts`),
 * kept in the doc's Y.Doc so every open page follows a write. A refused write
 * (a read-only page, or one past a limit) shows its reason in the status line.
 */
import { MDX_FLOW_LANGUAGE } from '@claude-workspaces/core/prose';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import { api, docIdFromPathOrNull } from './doc-path.ts';
import { UNREADABLE } from './mdx-chart-props.ts';
import { plotChartOf, renderPlotChart } from './mdx-plot-chart.ts';

export interface ComponentLive {
  ydoc: Y.Doc;
  /** False on a page that may read and may not write. */
  canWrite: boolean;
  /** `…/docs/<id>/components`, no trailing slash. */
  base: string;
}

/** The synced docs whose page said they are bound to an `.mdx` file, and
 *  whether that page may write. Only those run components: in a `.md` doc an
 *  `mdx-flow` block is something an editor typed, not a tag the server builds. */
const componentDocs = new WeakMap<Y.Doc, { canWrite: boolean }>();

/** Say whether `ydoc`'s page is an `.mdx` doc, and whether it may write.
 *  Called before the editor is made, since node views read it while it is made. */
export function setComponentDoc(ydoc: Y.Doc, isMdx: boolean, canWrite = true): void {
  if (isMdx) componentDocs.set(ydoc, { canWrite });
  else componentDocs.delete(ydoc);
}

/** The doc and address a node view's components come from, or null on a
 *  surface that is not a synced `.mdx` doc page. */
export function componentLiveOf(editor: Editor): ComponentLive | null {
  const state = ySyncPluginKey.getState(editor.state) as { doc?: Y.Doc } | undefined;
  const docId = typeof location === 'undefined' ? null : docIdFromPathOrNull(location.pathname);
  const page = state?.doc ? componentDocs.get(state.doc) : undefined;
  if (!state?.doc || !docId || !page) return null;
  return {
    ydoc: state.doc,
    canWrite: page.canWrite,
    base: api(`docs/${encodeURIComponent(docId)}/components`),
  };
}

/** The build key of the tag `text`, read against the editor's blocks, or
 *  null when the tag is not a component tag. */
export function componentKeyOf(doc: PMNode, text: string): string | null {
  const blocks: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'codeBlock' && n.attrs.language === MDX_FLOW_LANGUAGE) {
      blocks.push(n.textContent);
      return false;
    }
    return true;
  });
  return componentInputs(blocks).find((i) => i.tag === text)?.key ?? null;
}

const BUILTINS: ComponentHostApi = {
  builtins: {
    // Props reach a built-in as values, so none is unreadable. The title is
    // drawn as the block's own card draws it (`renderMdxSummary`), since a
    // chart inside a component has no card around it.
    PlotChart: (el, props) => {
      if (typeof props.title === 'string' && props.title) {
        const head = document.createElement('div');
        head.className = 'mdx-head';
        const title = document.createElement('span');
        title.className = 'mdx-title';
        title.textContent = props.title;
        head.appendChild(title);
        el.appendChild(head);
      }
      renderPlotChart(
        el,
        plotChartOf(new Map(Object.entries(props).filter(([, v]) => v !== UNREADABLE))),
      );
    },
  },
};

let redefineTolerated = false;
function tolerateRedefine(): void {
  if (redefineTolerated || typeof customElements === 'undefined') return;
  redefineTolerated = true;
  const define = customElements.define.bind(customElements);
  customElements.define = (name, ctor, options) => {
    if (customElements.get(name)) return;
    define(name, ctor, options);
  };
}

type Loader = (
  url: string,
) => Promise<{ default: (host: HTMLElement, api: ComponentHostApi) => unknown }>;

// The address is a value, so the doc bundle's build cannot fold it into a
// literal it would try to resolve.
let load: Loader = (url) => import(url);

/** How a test hands in its own module loader. The page never calls it. */
export function setComponentLoaderForTest(loader: Loader | null): void {
  load = loader ?? ((url) => import(url));
}

/** One tag's live drawing: a host the component draws into, and a status
 *  line for a build that is pending or failed. */
export class ComponentMount {
  readonly host = document.createElement('div');
  readonly status = document.createElement('div');
  private mounted: string | null = null;
  private cleanup: (() => void) | null = null;
  private token = 0;
  private stopObserve: (() => void) | null = null;
  private keyOf: () => string | null = () => null;
  /** The state hooks the mounted bundle was handed, torn down with it. */
  private hooks: OwnedStateHook[] = [];

  constructor(private readonly live: ComponentLive) {
    this.host.className = 'mdx-live';
    this.status.className = 'mdx-live-status';
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;
    const map = componentBuildsMap(live.ydoc);
    const onChange = () => this.show();
    map.observe(onChange);
    this.stopObserve = () => map.unobserve(onChange);
  }

  /**
   * Follow the build filed under the tag's key. The key is asked for again on
   * every change to the map, since an edit to the doc's imports moves it
   * without touching this tag's text; and once more after the editor has
   * finished building its view, which a node view is made in the middle of.
   */
  follow(keyOf: () => string | null): void {
    this.keyOf = keyOf;
    this.show();
    queueMicrotask(() => this.show());
  }

  private show(): void {
    const key = this.keyOf();
    if (key === null) return;
    const build = componentBuildOf(componentBuildsMap(this.live.ydoc), key);
    this.say(build);
    if (build?.hash && build.hash !== this.mounted) void this.mount(build.hash);
  }

  private say(build: ComponentBuild | undefined): void {
    const text = build?.error ?? (build?.hash || this.mounted ? '' : 'Building…');
    this.status.textContent = text;
    this.status.hidden = text === '';
    this.status.classList.toggle('is-error', build?.error !== undefined);
    this.status.classList.remove('is-refused');
  }

  private async mount(hash: string): Promise<void> {
    const mine = ++this.token;
    tolerateRedefine();
    let mod: Awaited<ReturnType<Loader>>;
    try {
      mod = await load(new URL(`${this.live.base}/${hash}.js`, location.href).href);
    } catch (err) {
      if (mine === this.token) this.fail(err);
      return;
    }
    if (mine !== this.token) return;
    this.release();
    try {
      const out = mod.default(this.host, { ...BUILTINS, state: (id) => this.stateFor(id) });
      if (typeof out === 'function') this.cleanup = out as () => void;
      this.mounted = hash;
      this.say(componentBuildOf(componentBuildsMap(this.live.ydoc), this.keyOf() ?? ''));
    } catch (err) {
      this.fail(err);
    }
  }

  /** A live state hook for `id`, whose refused writes say why in the status
   *  line and whose next accepted write clears that. */
  private stateFor(id: string): StateHook | undefined {
    if (!COMPONENT_STATE_ID.test(id)) return undefined;
    const hook = createStateHook(this.live.ydoc, id, { canWrite: this.live.canWrite });
    this.hooks.push(hook);
    const report = (out: ReturnType<StateHook['set']>) => {
      if (out.ok) {
        if (this.status.classList.contains('is-refused')) {
          this.status.classList.remove('is-refused', 'is-error');
          this.status.textContent = '';
          this.status.hidden = true;
        }
      } else {
        this.status.textContent = out.error;
        this.status.hidden = false;
        this.status.classList.add('is-error', 'is-refused');
      }
      return out;
    };
    return {
      canWrite: hook.canWrite,
      get: (path) => hook.get(path),
      set: (path, value) => report(hook.set(path, value)),
      push: (path, value) => report(hook.push(path, value)),
      delete: (path) => report(hook.delete(path)),
      on: (fn) => hook.on(fn),
    };
  }

  /** Run the mounted bundle's cleanup and drop its state listeners. */
  private release(): void {
    this.cleanup?.();
    this.cleanup = null;
    for (const h of this.hooks.splice(0)) h.dispose();
  }

  private fail(err: unknown): void {
    this.status.textContent = err instanceof Error ? err.message : String(err);
    this.status.hidden = false;
    this.status.classList.remove('is-refused');
    this.status.classList.add('is-error');
  }

  destroy(): void {
    this.token++;
    this.stopObserve?.();
    this.release();
  }
}
