/**
 * The level a meeting writes its headings at comes from the doc.
 *
 * THIS IS THE TEST THAT FAILS ON A BUILD THAT ASSUMES A LEVEL. Every case
 * below drives a doc whose own sections are NOT at level two, and asserts the
 * derivation follows them. Put `return 2` back in `notesTopicLevel` and four
 * of the six go red.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  NOTES_DEFAULT_TOPIC_LEVEL,
  notesSubTopicLevel,
  notesTopicHashes,
  notesTopicLevel,
} from '../src/notes-heading-level.ts';

/** The outline of a doc written as markdown — the shape every caller of the
 *  derivation actually has. */
function outlineOf(markdown: string): readonly prose.OutlineEntry[] {
  const ydoc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), markdown);
  return prose.readOutline(ydoc);
}

describe('notesTopicLevel', () => {
  it('takes the level the doc writes its sections at', () => {
    expect(notesTopicLevel(outlineOf('# Weekly sync\n\n## Roadmap\n\n## Hiring\n'))).toBe(2);
  });

  it('follows a doc nested under a project page, where sections are level three', () => {
    expect(notesTopicLevel(outlineOf('### Roadmap\n\nA line.\n\n### Hiring\n'))).toBe(3);
  });

  it('goes deeper still when the doc does', () => {
    expect(notesTopicLevel(outlineOf('#### One\n\n#### Two\n'))).toBe(4);
  });

  it('treats a lone `#` at the top as the title, and puts topics under it', () => {
    expect(notesTopicLevel(outlineOf('# Design review\n\nSome prose.\n'))).toBe(2);
  });

  it('but a lone `##` is the doc’s first SECTION, and a topic is its sibling', () => {
    // Read as a title instead, the second meeting on a doc wrote its heading a
    // level below the first meeting's, which ran the first section past it.
    expect(notesTopicLevel(outlineOf('## Design review\n\nSome prose.\n'))).toBe(2);
  });

  it('falls back on a doc with nothing to read', () => {
    expect(notesTopicLevel(outlineOf('Just a paragraph.\n'))).toBe(NOTES_DEFAULT_TOPIC_LEVEL);
    expect(notesTopicLevel([])).toBe(NOTES_DEFAULT_TOPIC_LEVEL);
  });

  it('never walks past the sixth level, which is not a heading at all', () => {
    expect(notesSubTopicLevel(outlineOf('###### Deep\n'))).toBe(6);
  });

  it('spells the level as the hashes a prompt quotes', () => {
    expect(notesTopicHashes(outlineOf('### A\n\n### B\n'))).toBe('###');
    expect(notesSubTopicLevel(outlineOf('### A\n\n### B\n'))).toBe(4);
  });
});
