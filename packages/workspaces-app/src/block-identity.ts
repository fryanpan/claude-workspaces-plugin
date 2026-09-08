import { prose } from '@claude-workspaces/core';
import { type Attribute, Extension } from '@tiptap/core';

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
  for (const name of prose.BLOCK_IDENTITY_ATTRS) {
    attrs[name] = { default: null, rendered: false };
  }
  return attrs;
}

export const BlockIdentity = Extension.create({
  name: 'blockIdentity',

  addGlobalAttributes() {
    return [{ types: BLOCK_TYPES, attributes: identityAttributes() }];
  },
});
