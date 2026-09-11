/**
 * A citation the note-taker wrote as `task:<title>` instead of as an address.
 *
 * The reproducing fixture is the note a live meeting actually produced: one
 * bullet came out carrying the literal words `(task:Production cost target)`,
 * with the row itself sitting in that tick's catalogue. Every rule here is a
 * PAIR — the citation that must become a link, and beside it the one that
 * must not, because a resolver tested only on what it links passes just as
 * happily when it links everything, which is the failure `notes-references.ts`
 * exists to refuse.
 *
 * The board rows are Riverbend's: the repo is public.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { type DocType, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  type NotesHeadingMemory,
  applyNotesUpdate,
  createNotesHeadingMemory,
} from '../src/meeting-notes-doc.ts';
import type { NotesUpdate } from '../src/meeting-notes.ts';
import type { NotesDocStore } from '../src/notes-doc-access.ts';
import { type NotesLinkSources, notesLinkSources } from '../src/notes-invented-links.ts';
import { resolveSchemeLinks } from '../src/notes-scheme-links.ts';
import { oneDocStore } from './notes-doc-helpers.ts';

/** The row the meeting named, as the catalogue holds it. */
const COST = {
  title: 'Production cost target',
  url: '/workspaces/w-riverbend?task=t-42',
  kind: 'task' as const,
};
const SPEC = {
  title: 'Harborlight spec',
  url: '/workspaces/w-riverbend/docs/d-spec',
  kind: 'doc' as const,
};

/** One `insert_at_end` carrying `markdown` — the shape a tick writes. */
function edit(markdown: string): prose.BlockEdit {
  return { op: 'insert_at_end', markdown };
}

/** The markdown of the one edit that came back. */
function only(edits: readonly prose.BlockEdit[]): string {
  const first = edits[0];
  if (!first || !('markdown' in first)) throw new Error('the fixture lost its edit');
  return first.markdown;
}

describe('a reference the tick was given becomes the row it names', () => {
  test('THE REPRODUCING FIXTURE: the bare parenthetical the live meeting wrote', () => {
    const out = resolveSchemeLinks(
      [edit('- The group cut the display to hold the budget (task:Production cost target).')],
      [COST],
    );
    expect(only(out.edits)).toBe(
      `- The group cut the display to hold the budget ([Production cost target](${COST.url})).`,
    );
    expect(out.linked).toEqual(['Production cost target']);
    expect(out.dropped).toEqual([]);
  });

  test('the bracketed form keeps the label the note-taker chose', () => {
    const out = resolveSchemeLinks(
      [edit('- [the cost cap](task:Production cost target) is the constraint.')],
      [COST],
    );
    expect(only(out.edits)).toBe(`- [the cost cap](${COST.url}) is the constraint.`);
  });

  test('the title is matched past its punctuation and its case', () => {
    const out = resolveSchemeLinks(
      [edit('- Raised again (task: production-cost target).')],
      [COST],
    );
    expect(only(out.edits)).toBe(`- Raised again ([Production cost target](${COST.url})).`);
  });

  test('a doc reference resolves the same way', () => {
    const out = resolveSchemeLinks(
      [edit('- The chair read it out (doc:Harborlight spec).')],
      [SPEC],
    );
    expect(only(out.edits)).toBe(`- The chair read it out ([Harborlight spec](${SPEC.url})).`);
  });

  test('a row cited by its own id is the same row', () => {
    const out = resolveSchemeLinks([edit('- Filed (task:t-42).')], [{ ...COST, id: 't-42' }]);
    expect(only(out.edits)).toBe(`- Filed ([Production cost target](${COST.url})).`);
  });
});

describe('a title the catalogue does not hold is never linked', () => {
  test('an unknown title leaves plain text and no parentheses artefact', () => {
    const out = resolveSchemeLinks(
      [edit('- The group cut the display to hold the budget (task:Saltmarsh rollout).')],
      [COST],
    );
    expect(only(out.edits)).toBe('- The group cut the display to hold the budget.');
    expect(out.dropped).toEqual(['task:Saltmarsh rollout']);
    expect(out.linked).toEqual([]);
  });

  test('an unknown title in the bracketed form keeps the words and loses the link', () => {
    const out = resolveSchemeLinks(
      [edit('- [the rollout](task:Saltmarsh rollout) slipped a week.')],
      [COST],
    );
    expect(only(out.edits)).toBe('- the rollout slipped a week.');
    expect(only(out.edits)).not.toContain('task:');
  });

  test('CONTROL: a near-miss on the title is a miss — nothing is guessed', () => {
    const out = resolveSchemeLinks([edit('- Watch the cost (task:Production cost).')], [COST]);
    expect(only(out.edits)).toBe('- Watch the cost.');
    expect(out.linked).toEqual([]);
  });

  test('with no catalogue at all, every citation comes out as words', () => {
    const out = resolveSchemeLinks([edit('- Over budget (task:Production cost target).')], []);
    expect(only(out.edits)).toBe('- Over budget.');
  });

  test('the right title of the wrong kind is not the thing that was cited', () => {
    // A board holds a row and the doc it was written from under one title.
    // `doc:` must answer with the doc even though the row is listed first.
    const row = {
      title: 'Harborlight spec',
      url: '/workspaces/w-riverbend?task=t-9',
      kind: 'task' as const,
    };
    const out = resolveSchemeLinks(
      [edit('- The chair read it out (doc:Harborlight spec).')],
      [row, SPEC],
    );
    expect(only(out.edits)).toBe(`- The chair read it out ([Harborlight spec](${SPEC.url})).`);
  });

  test('a scheme with no target of its kind links nothing', () => {
    const out = resolveSchemeLinks([edit('- Over budget (doc:Production cost target).')], [COST]);
    expect(only(out.edits)).toBe('- Over budget.');
    expect(out.linked).toEqual([]);
  });
});

describe('a citation lives on one line', () => {
  test('an unclosed citation does not swallow the notes after it', () => {
    // `[^()]` spans newlines, so this used to read as one citation running
    // to the `)` two bullets later, and rewrote all three as one.
    const unclosed = '- [the cap](task:Production cost target\n- The chair will confirm the sums.)';
    const out = resolveSchemeLinks([edit(unclosed)], [COST]);
    expect(only(out.edits)).toBe(unclosed);
    expect(out.dropped).toEqual([]);
  });

  test('CONTROL: two citations on two lines are each resolved on their own', () => {
    const out = resolveSchemeLinks(
      [
        edit(
          '- Over budget (task:Production cost target).\n- The chair read it out (doc:Harborlight spec).',
        ),
      ],
      [COST, SPEC],
    );
    expect(only(out.edits)).toBe(
      `- Over budget ([Production cost target](${COST.url})).\n` +
        `- The chair read it out ([Harborlight spec](${SPEC.url})).`,
    );
  });
});

describe('what the rule leaves alone', () => {
  test("a speaker tag is this pipeline's own mention, not a citation", () => {
    const one = edit('- [@the chair](speaker:B?t=10,12) wants the cheaper case.');
    const out = resolveSchemeLinks([one], [COST]);
    expect(out.edits[0]).toBe(one);
  });

  test('a real board link is not rewritten, object and all', () => {
    const one = edit(`- Filed as [Production cost target](${COST.url}).`);
    const out = resolveSchemeLinks([one], [COST]);
    expect(out.edits[0]).toBe(one);
    expect(out.dropped).toEqual([]);
  });

  test('an edit carrying no markdown passes through', () => {
    const del: prose.BlockEdit = { op: 'delete_block', blockId: 'blk-9' };
    const out = resolveSchemeLinks([del], [COST]);
    expect(out.edits[0]).toBe(del);
  });

  test('an ordinary parenthetical is not a citation and is kept', () => {
    const one = edit('- The case costs more than the budget (unconfirmed).');
    const out = resolveSchemeLinks([one], [COST]);
    expect(out.edits[0]).toBe(one);
  });
});

/* ===== The applier path ===== */

const AUTHOR_DOC = '## Meeting notes\n\n- an earlier point\n';

function meetingWithSection(): { store: NotesDocStore; memory: NotesHeadingMemory } {
  const ydoc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), AUTHOR_DOC);
  const store = oneDocStore('d', { ydoc, meta: { type: 'markdown' as DocType } });
  return { store, memory: createNotesHeadingMemory() };
}

function tick(edits: prose.BlockEdit[], linkSources: NotesLinkSources): NotesUpdate {
  return {
    docId: 'd',
    meetingId: 'm-1',
    tick: { tick: 1, reason: 'pause', turns: [{ turn: 0, text: 'we are over the cost target' }] },
    edits,
    linkSources,
  };
}

/** The doc as a reader of the bound file would see it. */
function markdownOf(store: NotesDocStore): string {
  const doc = store.get('d');
  if (!doc) throw new Error('the fixture lost its doc');
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
}

/** Everything `console.log` said while `run` ran. */
function captureLog(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines;
}

afterEach(() => {
  expect(typeof console.log).toBe('function');
});

describe('the applier writes the link, or writes words', () => {
  test('THE REPRODUCING FIXTURE reaches the doc as a link the reader can tap', () => {
    const { store, memory } = meetingWithSection();
    captureLog(() => {
      expect(
        applyNotesUpdate(
          store,
          tick(
            [edit('- The group cut the display to hold the budget (task:Production cost target).')],
            notesLinkSources({ references: [COST] }),
          ),
          memory,
        ),
      ).toBe(null);
    });
    const markdown = markdownOf(store);
    expect(markdown).toContain(`[Production cost target](${COST.url})`);
    expect(markdown).not.toContain('(task:');
  });

  test('an unknown title reaches the doc as words, with the residue gone', () => {
    const { store, memory } = meetingWithSection();
    const lines = captureLog(() => {
      applyNotesUpdate(
        store,
        tick(
          [edit('- The group cut the display to hold the budget (task:Saltmarsh rollout).')],
          notesLinkSources({ references: [COST] }),
        ),
        memory,
      );
    });
    const markdown = markdownOf(store);
    expect(markdown).toContain('The group cut the display to hold the budget.');
    expect(markdown).not.toContain('task:');
    const said = lines.filter((l) => l.includes('scheme citation'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('task:Saltmarsh rollout');
  });

  test('the resolved link survives the address check that runs after it', () => {
    // The two passes are in the order they are for this reason: a citation
    // rewritten to the row's real URL is one of the tick's own, so the
    // invented-link check keeps it rather than unwrapping it again.
    const { store, memory } = meetingWithSection();
    const lines = captureLog(() => {
      applyNotesUpdate(
        store,
        tick(
          [edit('- [the cost cap](task:Production cost target) is the constraint.')],
          notesLinkSources({ references: [COST] }),
        ),
        memory,
      );
    });
    expect(markdownOf(store)).toContain(`[the cost cap](${COST.url})`);
    expect(lines.filter((l) => l.includes('invented'))).toHaveLength(0);
  });
});
