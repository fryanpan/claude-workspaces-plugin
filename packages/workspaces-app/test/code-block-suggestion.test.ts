import { prose, suggestOps } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createEditor } from '../src/editor.ts';

/**
 * A proposal that touches a code block, opened in the real editor.
 *
 * Tiptap's code block admits no marks, and y-prosemirror answers a node the
 * schema refuses by DELETING it from the shared doc. So in prod, the first
 * browser to open a doc whose code block carried a proposal erased the whole
 * block — the person's code and the proposal with it — and the next
 * write-back put that on disk: `list_suggestions` came back empty and both
 * the old text and the new were gone.
 *
 * Everything here runs through `createEditor`, the extension list every
 * prose surface binds with, because that list IS the schema that decides.
 * Fixtures are synthetic.
 */

const AUTHOR = { id: 'agent:note-taker', name: 'Note Taker', color: '#4a90d9' };

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
});

const CODE = Array.from({ length: 40 }, (_, i) => `gate ${i}: open`).join('\n');
const DOC = `# Sluice log\n\nIntro.\n\n\`\`\`text\n${CODE}\n\`\`\`\n\nOutro.\n`;
const REPLACEMENT = '### Gates\n\n- east first\n  - then west\n\n```ts\nopen("east");\n```';

function docOf(md: string): Y.Doc {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md));
  prose.ensureBlockIds(ydoc);
  return ydoc;
}

function mount(ydoc: Y.Doc): HTMLElement {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const editor = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
  open.push(() => editor.destroy());
  return parent;
}

const md = (ydoc: Y.Doc) => prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));

describe('a proposal on a code block survives the editor opening the doc', () => {
  it('keeps the block, the person’s code and the proposal when replace_block proposes', () => {
    const ydoc = docOf(DOC);
    const blockId = prose.readOutline(ydoc).find((b) => b.text.startsWith('gate 0'))?.id as string;
    const res = prose.applyBlockEdits(
      ydoc,
      [{ op: 'replace_block', blockId, markdown: REPLACEMENT }],
      { author: AUTHOR.id, suggestionAuthor: AUTHOR },
    );
    expect(res.suggested).toBe(1);
    const before = md(ydoc);

    const parent = mount(ydoc);

    // The doc the server would write back is untouched by the render…
    expect(md(ydoc)).toBe(before);
    expect(md(ydoc)).toContain('gate 39: open');
    // …the proposal is still there to answer…
    const pending = suggestOps.listSuggestions(ydoc);
    expect(pending.map((s) => s.sid)).toEqual([res.outcomes[0]?.suggestionId]);
    // …and the reader sees the struck code inside its fence, not an empty page.
    const struck = parent.querySelector('pre code .cw-suggest-del');
    expect(struck?.textContent).toContain('gate 39: open');
    expect(parent.querySelector('h3 .cw-suggest-ins')?.textContent).toBe('Gates');

    // Answering it from the doc the editor is bound to still works.
    expect(suggestOps.acceptSuggestion(ydoc, pending[0]?.sid as string)).toEqual({ ok: true });
    expect(md(ydoc)).not.toContain('gate 39');
    expect(md(ydoc)).toContain('### Gates');
    expect(md(ydoc)).toContain('open("east");');
  });

  it('keeps a code block a find-style proposal edits inside the fence', () => {
    // The same schema answer hit every suggestion verb, not only block edits:
    // a suggest-mode find_and_replace whose match sits in a fence.
    const ydoc = docOf(DOC);
    const res = suggestOps.suggestReplace(ydoc, {
      find: 'gate 7: open',
      replace: 'gate 7: closed',
      author: AUTHOR,
    });
    expect(res.ok).toBe(true);
    const before = md(ydoc);

    mount(ydoc);

    expect(md(ydoc)).toBe(before);
    expect(suggestOps.listSuggestions(ydoc)).toHaveLength(1);
  });
});
