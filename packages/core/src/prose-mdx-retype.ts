/**
 * Turn the paragraphs of an `.mdx` doc that the MDX grammar reads as
 * components, expressions or import runs into the blocks that grammar makes.
 *
 * A doc parsed before `prose-mdx.ts` existed holds each component as a
 * paragraph, its source lines joined with spaces. Once any write-back had
 * flushed that paragraph, the file held the joined line too, and from then on
 * the doc and the file serialized to the same text: a paragraph and an
 * `mdx-flow` block of the same source write the same bytes. So the attach
 * found them in sync and never re-read the doc under the new grammar, and the
 * charts stayed paragraphs across every restart.
 *
 * This works on the doc rather than the file, block by block. A paragraph is
 * re-typed only when its whole serialized text is exactly one MDX construct,
 * and the new block holds that same text, so the file the doc serializes to
 * does not change by a byte. A paragraph carrying a pending suggestion is left
 * alone: re-typing it would drop the suggestion's marks.
 */
import * as Y from 'yjs';
import { BLOCK_IDENTITY_ATTRS } from './prose-identity.ts';
import { serializeBlockToMarkdown } from './prose-markdown.ts';
import { MDX_FLOW_LANGUAGE, mdxFlowEnd } from './prose-mdx.ts';
import { SUGGEST_DELETE_MARK, SUGGEST_INSERT_MARK } from './suggest.ts';

/**
 * Re-type every top-level paragraph of `fragment` that is one MDX construct.
 * Call inside a transaction. Returns how many blocks it re-typed.
 */
export function retypeMdxParagraphs(fragment: Y.XmlFragment): number {
  const kids = fragment.toArray();
  let retyped = 0;
  // From the end, so each replacement leaves the indexes before it valid.
  for (let i = kids.length - 1; i >= 0; i--) {
    const el = kids[i];
    if (!(el instanceof Y.XmlElement) || el.nodeName !== 'paragraph') continue;
    if (carriesSuggestion(el)) continue;
    const source = serializeBlockToMarkdown(el);
    const lines = source.split('\n');
    if (source.trim() === '' || mdxFlowEnd(lines, 0) !== lines.length) continue;
    const block = new Y.XmlElement('codeBlock');
    block.setAttribute('language', MDX_FLOW_LANGUAGE);
    // The block keeps its address and its author, so an outline id an agent
    // holds still names it.
    for (const name of BLOCK_IDENTITY_ATTRS) {
      const value = el.getAttribute(name);
      if (typeof value === 'string') block.setAttribute(name, value);
    }
    const text = new Y.XmlText();
    text.insert(0, source);
    block.insert(0, [text]);
    fragment.delete(i, 1);
    fragment.insert(i, [block]);
    retyped++;
  }
  return retyped;
}

function carriesSuggestion(el: Y.XmlElement): boolean {
  return el
    .toArray()
    .some(
      (child) =>
        child instanceof Y.XmlText &&
        (child.toDelta() as { attributes?: Record<string, unknown> }[]).some(
          (op) =>
            op.attributes?.[SUGGEST_INSERT_MARK] != null ||
            op.attributes?.[SUGGEST_DELETE_MARK] != null,
        ),
    );
}
