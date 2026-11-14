/**
 * Which tags in a bound `.mdx` doc are components the server builds, and the
 * key each build is filed under.
 *
 * A doc's `import` lines and its JSX tags are `mdx-flow` code blocks
 * (`prose-mdx.ts`), each holding its exact source. A tag is a component tag
 * when it uses a name one of those imports binds from a path the server can
 * build: a relative `.ts` / `.tsx` / `.js` / `.jsx` / `.mjs` file, or an
 * `https://` module. A tag that uses a bare import (`from 'leaflet'`) is one
 * too, so the build can refuse it with the fix. Any other tag — `<PlotChart>` or
 * `<StreetMap>` with no import, a tag whose import is an `.astro` file — keeps the preview
 * it has today.
 *
 * The server (`server/src/doc-component-builds.ts`) and the page
 * (`workspaces-app/src/mdx-component.ts`) both run this over the same blocks
 * in the same order, so both arrive at the same key without asking each
 * other: the server files each build in the doc's `componentBuilds` map under
 * the key, and the page looks its own tag up there. The map syncs like the
 * rest of the doc, so a rebuild reaches every open page.
 *
 * A scan, never an evaluation: nothing here runs the source.
 */
import * as Y from 'yjs';
import { MDX_FLOW_LANGUAGE } from './prose-mdx.ts';

/** The doc's map of builds, keyed by `componentBuildKey`. */
export const COMPONENT_BUILDS_MAP = 'componentBuilds';

/** What the server records for one tag. A failed rebuild keeps the last
 *  good `hash` beside its `error`, so the page keeps showing what worked. */
export interface ComponentBuild {
  /** The built bundle's content hash; the page fetches `components/<hash>.js`. */
  hash?: string;
  /** Why the last build failed, written for the doc's author. */
  error?: string;
  /** When the server last built or refused it (ms). */
  at: number;
}

/** How an import's specifier is treated. */
export type ImportKind = 'local' | 'cdn' | 'bare' | 'other';

export interface MdxImport {
  /** The statement exactly as written. */
  source: string;
  specifier: string;
  /** The local names it binds. */
  names: string[];
  kind: ImportKind;
}

/** One tag the server builds. */
export interface ComponentInput {
  key: string;
  /** The import statements the tag uses, in doc order. */
  imports: string[];
  /** The tag's source, exactly as written. */
  tag: string;
}

/** Files a component may be written in. */
export const COMPONENT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'] as const;

/** Tags the page draws itself, which a component tag may hold without an import. */
export const BUILTIN_TAGS = ['PlotChart', 'StreetMap'] as const;

export function importKind(specifier: string): ImportKind {
  if (/^https?:\/\//i.test(specifier)) return 'cdn';
  if (/^\.{0,2}\//.test(specifier)) {
    const ext = /\.[a-z0-9]+$/i.exec(specifier)?.[0]?.toLowerCase() ?? '';
    return (COMPONENT_EXTENSIONS as readonly string[]).includes(ext) ? 'local' : 'other';
  }
  // `astro:content`, `node:fs` and other schemes are not packages esm.sh serves.
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return 'other';
  return 'bare';
}

const IMPORT_RE =
  /\bimport\s+(?:(type\s+)?([\w$\s{},*]+?)\s+from\s+)?(['"])([^'"\n]+)\3(?:\s*with\s*\{[^}]*\})?\s*;?/g;

/** The import statements in an `import` / `export` block. */
export function parseImports(block: string): MdxImport[] {
  const out: MdxImport[] = [];
  for (const m of block.matchAll(IMPORT_RE)) {
    if (m[1]) continue; // `import type` binds nothing at run time
    const specifier = m[4] ?? '';
    out.push({
      source: m[0].trim(),
      specifier,
      names: bindings(m[2] ?? ''),
      kind: importKind(specifier),
    });
  }
  return out;
}

function bindings(clause: string): string[] {
  const names: string[] = [];
  const named = /\{([^}]*)\}/.exec(clause);
  for (const part of (named?.[1] ?? '').split(',')) {
    const p = part.trim();
    // `{ type Bounds }` binds nothing at run time either.
    if (!p || /^type\s/.test(p)) continue;
    const as = /\bas\s+([\w$]+)$/.exec(p);
    names.push(as?.[1] ?? p);
  }
  const rest = clause.replace(/\{[^}]*\}/, ' ');
  const ns = /\*\s*as\s+([\w$]+)/.exec(rest);
  if (ns?.[1]) names.push(ns[1]);
  const def = /^\s*([A-Za-z_$][\w$]*)/.exec(rest.replace(/\*\s*as\s+[\w$]+/, ''));
  if (def?.[1]) names.push(def[1]);
  return names;
}

const isTag = (s: string) => /^<[A-Za-z]/.test(s.trimStart());
const isEsm = (s: string) => /^(?:import|export)\b/.test(s.trimStart());
const usesName = (tag: string, name: string) =>
  new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(tag);

/**
 * The component tags among a doc's `mdx-flow` blocks, given in doc order. An
 * import counts wherever it sits in the doc, as MDX hoists it.
 */
export function componentInputs(blocks: readonly string[]): ComponentInput[] {
  const imports = blocks.filter(isEsm).flatMap(parseImports);
  const out: ComponentInput[] = [];
  for (const block of blocks) {
    if (!isTag(block)) continue;
    const used = imports.filter((i) => i.names.some((n) => usesName(block, n)));
    if (!used.some((i) => i.kind !== 'other')) continue;
    const sources = used.map((i) => i.source);
    out.push({ key: componentBuildKey(sources, block), imports: sources, tag: block });
  }
  return out;
}

/** The key a tag's build is filed under: a hash of what goes into it. */
export function componentBuildKey(imports: readonly string[], tag: string): string {
  const text = `${imports.join('\n')}\n\u0000\n${tag}`;
  return hex(cyrb53(text, 1)) + hex(cyrb53(text, 2));
}

const hex = (n: number) => n.toString(16).padStart(14, '0');

/** A 53-bit string hash (cyrb53). Not a security boundary: two tags with one
 *  key would share a build, and both were written by an editor of the doc. */
function cyrb53(s: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** The text of every `mdx-flow` block in a prose fragment, in doc order. */
export function mdxFlowSources(fragment: Y.XmlFragment): string[] {
  const out: string[] = [];
  const walk = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'codeBlock' && child.getAttribute('language') === MDX_FLOW_LANGUAGE) {
        out.push(textOf(child));
        continue;
      }
      walk(child);
    }
  };
  walk(fragment);
  return out;
}

function textOf(el: Y.XmlElement): string {
  let s = '';
  for (const c of el.toArray()) {
    if (!(c instanceof Y.XmlText)) continue;
    for (const op of c.toDelta() as Array<{ insert?: unknown }>) {
      if (typeof op.insert === 'string') s += op.insert;
    }
  }
  return s;
}

export function componentBuildsMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap(COMPONENT_BUILDS_MAP);
}

/** A recorded build, or undefined for anything that is not one. */
export function componentBuildOf(map: Y.Map<unknown>, key: string): ComponentBuild | undefined {
  const v = map.get(key) as Partial<ComponentBuild> | undefined;
  if (!v || typeof v !== 'object' || typeof v.at !== 'number') return undefined;
  const out: ComponentBuild = { at: v.at };
  if (typeof v.hash === 'string' && /^[a-f0-9]{16,64}$/.test(v.hash)) out.hash = v.hash;
  if (typeof v.error === 'string') out.error = v.error;
  return out;
}
