import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
/**
 * What an agent reads and does to the components of a bound `.mdx` doc
 * (design decision 5's agent path, task 4): list them, read and write their
 * state, and place a new tag. `routes/doc-component-agent.ts` addresses
 * these; the MCP tools are `list_components`, `get_component_state`,
 * `set_component_state` and `place_component`.
 *
 * State is the doc's own (`core/mdx-component-state.ts`): a write here lands
 * in the same Y.Doc every open page holds, so it reaches them over their
 * sockets like a peer's write, with the same limits a page is held to. A tag
 * is placed through the block-edit path every agent edit takes, so it is
 * attributed to the agent and written back to the `.mdx` like any edit.
 *
 * A component's state outlives its tag (design: deleting a tag keeps the
 * state). `listComponents` names such a state `placed: false` until a tag
 * with its id returns.
 *
 * A source git ignores builds only from a folder the owner granted.
 * `grantFolderFor` turns an agent's request into the folder its access card
 * names; `confirmGrantFolder` re-checks it when the owner approves.
 */
import { prose } from '@claude-workspaces/core';
import {
  COMPONENT_STATE_ID,
  type StateOp,
  applyStateOps,
  componentStateIds,
  readComponentState,
} from '@claude-workspaces/core/mdx-component-state';
import {
  type ComponentBuild,
  componentBuildOf,
  componentBuildsMap,
  componentInputs,
  componentTagIds,
  importKind,
  mdxFlowSources,
  parseImports,
} from '@claude-workspaces/core/mdx-components';
import { isMdxPath } from '@claude-workspaces/core/prose';
import { type BuildGuards, declaringManifest, gitWorkTree } from './component-build.ts';
import type { BlockEditsAuthor, BlockEditsResult } from './doc-outline-ops.ts';
import type { LiveDoc } from './doc-store.ts';

/** Where every component runs, and why: the reader's answer to "is it framed?". */
export const RUNS_IN_PAGE =
  "In the doc page, for every reader, with the reader's session: no component runs in a frame, because everyone with edit access is trusted (design decision 2).";

export type BuildStatus =
  | { status: 'built'; hash: string; at: number }
  | { status: 'failed'; error: string; at: number; lastGoodHash?: string }
  | { status: 'pending' };

export interface ComponentRow {
  /** The state id, or null for a tag that names none. */
  id: string | null;
  /** Every state id the tag names (a tag can hold children with their own). */
  ids: string[];
  placed: boolean;
  /** The tag's source, as written; null for a state with no tag. */
  tag: string | null;
  build: BuildStatus | null;
  hasState: boolean;
  runs: 'page';
  why: string;
}

const TAG_MAX = 400;

function statusOf(build: ComponentBuild | undefined): BuildStatus {
  if (!build) return { status: 'pending' };
  if (build.error !== undefined) {
    return {
      status: 'failed',
      error: build.error,
      at: build.at,
      ...(build.hash ? { lastGoodHash: build.hash } : {}),
    };
  }
  return build.hash ? { status: 'built', hash: build.hash, at: build.at } : { status: 'pending' };
}

/** Every component tag of the doc, then every state no tag names. */
export function listComponents(doc: LiveDoc): ComponentRow[] {
  const map = componentBuildsMap(doc.ydoc);
  const withState = new Set(componentStateIds(doc.ydoc));
  const placed = new Set<string>();
  const rows: ComponentRow[] = [];
  for (const input of componentInputs(mdxFlowSources(prose.getProseFragment(doc.ydoc)))) {
    const ids = componentTagIds(input.tag);
    for (const id of ids) placed.add(id);
    rows.push({
      id: ids[0] ?? null,
      ids,
      placed: true,
      tag: input.tag.length > TAG_MAX ? `${input.tag.slice(0, TAG_MAX - 1)}…` : input.tag,
      build: statusOf(componentBuildOf(map, input.key)),
      hasState: ids.some((id) => withState.has(id)),
      runs: 'page',
      why: RUNS_IN_PAGE,
    });
  }
  for (const id of withState) {
    if (placed.has(id)) continue;
    rows.push({
      id,
      ids: [id],
      placed: false,
      tag: null,
      build: null,
      hasState: true,
      runs: 'page',
      why: 'No tag in the doc names this id, so nothing draws it. The state is kept; a tag with this id shows it again.',
    });
  }
  return rows;
}

export type AgentResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const fail = (status: number, error: string): { ok: false; status: number; error: string } => ({
  ok: false,
  status,
  error,
});

function checkId(id: string): string | null {
  return COMPONENT_STATE_ID.test(id)
    ? null
    : `"${id}" is not a component id: use 1 to 64 of a-z, 0-9 and -.`;
}

/** The value at `path` in component `id`'s state, or the whole state. */
export function getComponentState(
  doc: LiveDoc,
  id: string,
  path?: string,
): AgentResult<{ id: string; path: string; value: unknown; placed: boolean }> {
  const bad = checkId(id);
  if (bad) return fail(400, bad);
  let at: unknown = readComponentState(doc.ydoc, id);
  for (const seg of path ? path.split('.') : []) {
    if (Array.isArray(at)) at = at[Number(seg)];
    else if (at !== null && typeof at === 'object' && Object.hasOwn(at, seg)) {
      at = (at as Record<string, unknown>)[seg];
    } else {
      at = undefined;
      break;
    }
  }
  const placed = listComponents(doc).some((r) => r.placed && r.ids.includes(id));
  return { ok: true, value: { id, path: path ?? '', value: at ?? null, placed } };
}

/** The transaction origin of an agent's state write, naming the agent. */
export const agentStateOrigin = (agentId: string) => ({ componentStateBy: agentId });

/** Apply `ops` to component `id` in one transaction, as `agentId`. */
export function setComponentState(
  doc: LiveDoc,
  id: string,
  ops: unknown,
  agentId: string,
): AgentResult<{ id: string; state: Record<string, unknown> }> {
  const bad = checkId(id);
  if (bad) return fail(400, bad);
  if (!Array.isArray(ops)) return fail(400, 'ops must be a list of {op, path, value?}.');
  const res = applyStateOps(doc.ydoc, id, ops as StateOp[], { origin: agentStateOrigin(agentId) });
  if (!res.ok) return fail(400, res.error);
  return { ok: true, value: { id, state: readComponentState(doc.ydoc, id) } };
}

export interface PlaceRequest {
  importPath: unknown;
  name?: unknown;
  props: unknown;
  headingId?: unknown;
}

export interface PlaceDeps {
  boundPath: string | undefined;
  applyBlockEdits: (edits: prose.BlockEdit[], who: BlockEditsAuthor) => BlockEditsResult;
  /** Build the doc's tags now; resolves when the build is filed. */
  refresh: () => Promise<void>;
}

const NAME = /^[A-Z][A-Za-z0-9_$]{0,63}$/;
const PROP = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const PROPS_MAX = 20_000;

/** A component name from a file: `./map/index.ts` → `Map`, `./pin-list.tsx` → `PinList`. */
export function nameFromPath(importPath: string): string {
  const parts = importPath.split(/[/?#]/).filter((p) => p !== '' && p !== '.' && p !== '..');
  let base = (parts.at(-1) ?? '').replace(/@[^@]*$/, '').replace(/\.[a-z0-9]+$/i, '');
  if (base === 'index' && parts.length > 1) base = parts.at(-2) ?? base;
  const pascal = base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join('');
  return NAME.test(pascal) ? pascal : 'Component';
}

/** `props` as JSX attributes: a plain string in quotes, anything else as `{json}`. */
function attributes(props: Record<string, unknown>): string {
  return Object.entries(props)
    .map(([k, v]) =>
      typeof v === 'string' && !/["{}\n<>]/.test(v) ? `${k}="${v}"` : `${k}={${JSON.stringify(v)}}`,
    )
    .join(' ');
}

/**
 * Insert `<Name {...props} />` under a heading or at the end, with the import
 * line before it when the doc has none for `importPath`, then build it.
 */
export async function placeComponent(
  doc: LiveDoc,
  req: PlaceRequest,
  who: BlockEditsAuthor,
  deps: PlaceDeps,
): Promise<AgentResult<{ id: string; tag: string; addedImport: boolean; build: BuildStatus }>> {
  if (!deps.boundPath || !isMdxPath(deps.boundPath)) {
    return fail(409, 'Components are placed only in a doc bound to an .mdx file.');
  }
  const spec = req.importPath;
  if (typeof spec !== 'string' || spec.length > 500 || /["'`\n\\]/.test(spec)) {
    return fail(400, 'importPath must be a path or URL with no quotes, backslashes or newlines.');
  }
  const kind = importKind(spec);
  if (kind !== 'local' && kind !== 'cdn') {
    return fail(
      400,
      `importPath must be a relative .ts/.tsx/.js/.jsx/.mjs file (like './map/index.ts') or an esm.sh URL at an exact version; '${spec}' is neither.`,
    );
  }
  const props = req.props;
  if (props === null || typeof props !== 'object' || Array.isArray(props)) {
    return fail(400, 'props must be an object, holding at least a string id.');
  }
  const p = props as Record<string, unknown>;
  if (typeof p.id !== 'string') return fail(400, 'props.id must be a string: the state id.');
  const badId = checkId(p.id);
  if (badId) return fail(400, badId);
  for (const k of Object.keys(p)) {
    if (!PROP.test(k) || k === 'children')
      return fail(400, `"${k}" is not a prop name a tag can carry.`);
  }
  let json: string;
  try {
    json = JSON.stringify(p);
  } catch {
    return fail(400, 'props must be plain JSON.');
  }
  if (json.length > PROPS_MAX)
    return fail(400, `props must be under ${PROPS_MAX} characters as JSON.`);

  const blocks = mdxFlowSources(prose.getProseFragment(doc.ydoc));
  const existing = blocks
    .filter((b) => /^(?:import|export)\b/.test(b.trimStart()))
    .flatMap(parseImports)
    .find((i) => i.specifier === spec && i.names.length > 0);
  if (req.name !== undefined && (typeof req.name !== 'string' || !NAME.test(req.name))) {
    return fail(
      400,
      'name must start with a capital letter and hold only letters, digits, _ and $.',
    );
  }
  const name = existing?.names[0] ?? (typeof req.name === 'string' ? req.name : nameFromPath(spec));
  const tag = `<${name} ${attributes(p)} />`;
  const markdown = existing ? tag : `import ${name} from '${spec}'\n\n${tag}`;
  const edit: prose.BlockEdit =
    typeof req.headingId === 'string' && req.headingId !== ''
      ? { op: 'insert_under_heading', headingId: req.headingId, markdown }
      : { op: 'insert_at_end', markdown };
  const res = deps.applyBlockEdits([edit], who);
  if (!res.ok) return fail(res.error === 'not-found' ? 404 : 409, res.error);
  const outcome = res.outcomes[0];
  if (!outcome || outcome.status === 'failed') {
    const why = outcome && 'error' in outcome ? String(outcome.error) : 'not applied';
    return fail(409, `The tag was not inserted: ${why}.`);
  }
  await deps.refresh();
  const input = componentInputs(mdxFlowSources(prose.getProseFragment(doc.ydoc))).find(
    (i) => i.tag === tag,
  );
  const build = input
    ? statusOf(componentBuildOf(componentBuildsMap(doc.ydoc), input.key))
    : ({ status: 'pending' } as const);
  return { ok: true, value: { id: p.id, tag, addedImport: !existing, build } };
}

/** The real path of a directory, or null. */
function realDir(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * The folder an agent's grant request names, as the access card will: a real
 * directory inside the doc's git work tree, declared by a `component.json`,
 * and not inside a walled lead's folder. `folder` is relative to the doc's
 * own folder, or absolute.
 */
export async function grantFolderFor(
  boundPath: string | undefined,
  folder: unknown,
  guards: Pick<BuildGuards, 'allows' | 'covers'>,
): Promise<AgentResult<string>> {
  if (!boundPath || !isMdxPath(boundPath)) {
    return fail(409, 'Component folders are granted only for a doc bound to an .mdx file.');
  }
  if (
    typeof folder !== 'string' ||
    folder === '' ||
    folder.length > 4096 ||
    folder.includes('\0')
  ) {
    return fail(400, 'folder must be a path: relative to the doc, or absolute.');
  }
  const docDir = dirname(boundPath);
  const real = realDir(isAbsolute(folder) ? folder : resolve(docDir, folder));
  if (!real) return fail(400, `${folder} is not a folder.`);
  if (!guards.allows(real) || guards.covers(real)) {
    return fail(403, "Components are not built from a walled lead's folder.");
  }
  const workTree = await gitWorkTree(docDir);
  if (!workTree || !real.startsWith(workTree + sep)) {
    return fail(400, `${folder} is not inside the doc's git work tree.`);
  }
  if (!declaringManifest(resolve(real, 'x'), workTree, new Set())) {
    return fail(
      400,
      `No component.json declares ${folder}: add one to the folder (or a folder above it, inside the repository) first.`,
    );
  }
  return { ok: true, value: real };
}

/** Whether `folder`, from an approved card, is still a real directory as named. */
export function confirmGrantFolder(folder: string): { ok: true } | { ok: false; error: string } {
  const real = realDir(folder);
  if (real === null) return { ok: false, error: `${folder} is no longer a folder.` };
  if (real !== folder) return { ok: false, error: `${folder} now leads somewhere else (${real}).` };
  return { ok: true };
}
