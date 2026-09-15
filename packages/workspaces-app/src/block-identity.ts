// A NAMED import, not `prose.BLOCK_IDENTITY_ATTRS` off the namespace object.
// A property read on a namespace is invisible to the bundler's tree-shaker:
// it dropped prose-identity.ts as unreachable and left the namespace holding
// a getter for a binding that no longer existed, so this line threw
// `ReferenceError` the moment tiptap called addGlobalAttributes — every doc
// page in production, chrome and no body (PR 817, reverted as PR 819).
// `bun run check:client-boot` is the gate that now loads the built bundle.
import {
  BLOCK_AUTHOR_ATTR,
  BLOCK_IDENTITY_ATTRS,
  BLOCK_ID_ATTR,
} from '@claude-workspaces/core/prose';
import { type Attribute, Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { type EditorState, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform';
import { ySyncPluginKey } from '@tiptap/y-tiptap';

/**
 * Declares the two block-identity attributes — `cwId` and `cwAuthor`, minted
 * and read server-side by `packages/core/src/prose-outline.ts` — on every
 * block node type this editor's schema has.
 *
 * **Without this the browser deletes them.** y-prosemirror builds a
 * ProseMirror node from a Yjs element by handing the element's attributes to
 * `schema.node()`, which drops every key the node type does not declare; on
 * the next local edit `updateYFragment` writes the node's attributes back and
 * removes every Yjs attribute the node did not carry. So an attribute the
 * schema has never heard of is stripped the first time anyone types in that
 * block. Its `equalAttrs` also compares key COUNTS, so an undeclared
 * attribute additionally reads as a difference and forces the block to be
 * re-created — which is how the note-taker's own bullets came back under
 * browser-minted identity.
 *
 * `default: null` so a block that has never been given an identity is
 * unchanged (a null attribute is written back as an absent one, not as an
 * empty string); `rendered: false` so neither name ever reaches the DOM or a
 * copy/paste HTML round trip — the Yjs element is the only place they live.
 *
 * **An id names ONE block.** Tiptap's attributes default to `keepOnSplit:
 * true`, so before this said otherwise, Enter at the end of a paragraph or a
 * bullet handed the new block the old one's id and author: four Enters in a
 * list made five bullets under one id, and the outline read that back as one
 * address for five blocks. A split's new half is a block a person just made,
 * so it gets neither. A copy-drag inside the editor carries its slice's
 * attributes the same way, which no attribute option reaches, so the plugin
 * below clears them off a copy whose id still sits on another block.
 *
 * Registered in `createEditor`'s BASE extension list. Deleting it silently
 * un-does all of the server-side identity work.
 */

/** Every block node type in the editor's schema (editor.ts's extension list:
 *  StarterKit, MermaidCodeBlock — still named `codeBlock` — Image and the
 *  table family). Table internals are deliberately absent: nothing addresses
 *  a cell by id, and core's outline mints none there either. */
const BLOCK_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'listItem',
  'horizontalRule',
  'image',
  'table',
];

/** The attribute spec, keyed by the names core owns — never retyped here, so
 *  a rename in core cannot drift out of the browser's schema. */
function identityAttributes(): Record<string, Partial<Attribute>> {
  const attrs: Record<string, Partial<Attribute>> = {};
  for (const name of BLOCK_IDENTITY_ATTRS) {
    attrs[name] = { default: null, rendered: false, keepOnSplit: false };
  }
  return attrs;
}

/** Every id the transaction's steps put INTO the doc, read off their slices.
 *  Typing inserts text slices, so the common keystroke returns empty here and
 *  the doc is never walked for it. */
function insertedIds(tr: Transaction): Set<string> {
  const ids = new Set<string>();
  for (const step of tr.steps) {
    if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) continue;
    step.slice.content.descendants((node) => {
      const id = node.attrs[BLOCK_ID_ATTR];
      if (typeof id === 'string' && id.length > 0) ids.add(id);
      return !node.isTextblock;
    });
  }
  return ids;
}

/** The ranges of the final doc the transaction wrote, mapped to its end. */
function insertedRanges(tr: Transaction): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  tr.mapping.maps.forEach((map, i) => {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (newEnd <= newStart) return;
      const rest = tr.mapping.slice(i + 1);
      ranges.push({ from: rest.map(newStart, 1), to: rest.map(newEnd, -1) });
    });
  });
  return ranges;
}

/**
 * Clear the identity off every block a local edit wrote whose id another
 * block already holds. The block that was there first keeps the address; the
 * copy goes back to having none, and the server mints it one of its own on
 * the next outline read. When every holder is new — the same slice dropped
 * twice — the first in document order keeps it.
 *
 * Remote transactions are left alone: the server's copy of the doc is what
 * they came from, and it answers for its own ids at load.
 */
export function dedupeInsertedIds(
  trs: readonly Transaction[],
  state: EditorState,
): Transaction | null {
  const ids = new Set<string>();
  let ranges: Array<{ from: number; to: number }> = [];
  for (const tr of trs) {
    if (!tr.docChanged || tr.getMeta(ySyncPluginKey)) continue;
    ranges = ranges.map((r) => ({ from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) }));
    const found = insertedIds(tr);
    if (found.size === 0) continue;
    for (const id of found) ids.add(id);
    ranges.push(...insertedRanges(tr));
  }
  if (ids.size === 0) return null;

  const holders = new Map<string, Array<{ pos: number; node: PMNode }>>();
  state.doc.descendants((node, pos) => {
    const id = node.attrs[BLOCK_ID_ATTR];
    if (typeof id === 'string' && ids.has(id)) {
      const list = holders.get(id) ?? [];
      list.push({ pos, node });
      holders.set(id, list);
    }
    return !node.isTextblock;
  });

  const inserted = (pos: number): boolean => ranges.some((r) => pos >= r.from && pos < r.to);
  let out: Transaction | null = null;
  for (const list of holders.values()) {
    if (list.length < 2) continue;
    const keeper = list.find((h) => !inserted(h.pos)) ?? list[0];
    for (const h of list) {
      if (h === keeper) continue;
      out = out ?? state.tr;
      out.setNodeMarkup(h.pos, undefined, {
        ...h.node.attrs,
        [BLOCK_ID_ATTR]: null,
        [BLOCK_AUTHOR_ATTR]: null,
      });
    }
  }
  return out;
}

export const BlockIdentity = Extension.create({
  name: 'blockIdentity',

  addGlobalAttributes() {
    return [{ types: BLOCK_TYPES, attributes: identityAttributes() }];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('cwBlockIdentityDedupe'),
        appendTransaction: (trs, _old, state) => dedupeInsertedIds(trs, state),
      }),
    ];
  },
});
