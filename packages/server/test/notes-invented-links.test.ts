import { afterEach, describe, expect, test } from 'bun:test';
/**
 * Every rule here is a PAIR: a link that must be dropped, and beside it the
 * link from the same source that must survive. A stripper tested only on what
 * it removes passes just as happily when it removes everything, which is the
 * failure mode that would cost the notes their real citations.
 *
 * The invented links are the two a measured eval run actually produced — an
 * archive URL for a page nobody named, and a bare `url:speech-recognition`
 * that is not an address at all. Everything else is fictional: the repo is
 * public, so the board rows are Riverbend's and the hosts are example.com.
 */
import { type DocType, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  type NotesHeadingMemory,
  applyNotesUpdate,
  createNotesHeadingMemory,
} from '../src/meeting-notes-doc.ts';
import type { NotesUpdate } from '../src/meeting-notes.ts';
import { NOTES_AUTHOR_ID, type NotesDocStore } from '../src/notes-doc-access.ts';
import {
  type NotesLinkSources,
  findInventedLinks,
  notesLinkSources,
  stripInventedLinks,
} from '../src/notes-invented-links.ts';
import { oneDocStore } from './notes-doc-helpers.ts';

const ARCHIVE = 'https://web.archive.org/web/2019/https://example.com/notes';
const NOT_AN_ADDRESS = 'url:speech-recognition';
const ROW = '/workspaces/w-riverbend?task=t-42';

/** One `insert_under_heading` carrying `markdown` — the shape a tick writes. */
function edit(markdown: string): prose.BlockEdit {
  return { op: 'insert_under_heading', headingId: 'blk-notes', markdown };
}

function sources(over: Partial<NotesLinkSources> = {}): NotesLinkSources {
  return { urls: over.urls ?? [], text: over.text ?? [] };
}

describe('a link the tick was never given is unwrapped', () => {
  test('an invented URL is dropped and the bullet keeps its words', () => {
    const out = stripInventedLinks(
      [edit(`- The gate moves to [Riverbend's archive](${ARCHIVE}) before merge.`)],
      sources({ urls: [ROW] }),
    );
    expect(out.dropped).toEqual([ARCHIVE]);
    const only = out.edits[0]!;
    expect('markdown' in only ? only.markdown : '').toBe(
      "- The gate moves to Riverbend's archive before merge.",
    );
  });

  test('a destination that is not an address at all is dropped too', () => {
    const out = stripInventedLinks(
      [edit(`- Dropping [speech recognition](${NOT_AN_ADDRESS}) for now.`)],
      sources(),
    );
    expect(out.dropped).toEqual([NOT_AN_ADDRESS]);
    const only = out.edits[0]!;
    expect('markdown' in only ? only.markdown : '').toBe('- Dropping speech recognition for now.');
  });

  test('two invented links in one batch are both reported, in the order written', () => {
    const out = stripInventedLinks(
      [edit(`- [one](${ARCHIVE})`), edit(`- [two](${NOT_AN_ADDRESS})`)],
      sources(),
    );
    expect(out.dropped).toEqual([ARCHIVE, NOT_AN_ADDRESS]);
  });

  test('the image form loses its bang with the link', () => {
    const out = stripInventedLinks([edit(`- ![a chart](${ARCHIVE})`)], sources());
    const only = out.edits[0]!;
    expect('markdown' in only ? only.markdown : '').toBe('- a chart');
  });
});

describe('a link from each source the tick was given survives', () => {
  test('a matched board reference', () => {
    const given = notesLinkSources({ references: [{ url: ROW }] });
    expect(findInventedLinks([edit(`- [Riverbend gate](${ROW}) moved.`)], given)).toEqual([]);
  });

  test('a captured task link', () => {
    const given = notesLinkSources({ taskLinks: [{ url: ROW }] });
    expect(findInventedLinks([edit(`- Filed as [Riverbend gate](${ROW}).`)], given)).toEqual([]);
  });

  test('a resolved doc lookup', () => {
    const given = notesLinkSources({ docLinks: [{ url: '/review/d-riverbend' }] });
    expect(findInventedLinks([edit('- See [last time](/review/d-riverbend).')], given)).toEqual([]);
  });

  test('a suggestion the pipeline is about to append, marker and all', () => {
    const given = notesLinkSources({ suggestions: [{ url: ROW }] });
    expect(findInventedLinks([edit(`- [Related: gate?](${ROW}&suggest=1)`)], given)).toEqual([]);
  });

  test('a URL spoken verbatim in this tick', () => {
    const given = notesLinkSources({
      turns: [{ text: 'pull it from https://example.com/riverbend/spec before Friday' }],
    });
    expect(
      findInventedLinks([edit('- Read [the spec](https://example.com/riverbend/spec).')], given),
    ).toEqual([]);
  });

  test('a URL already written in the doc the tick read', () => {
    const given = notesLinkSources({
      outline: [{ text: 'agenda: [the spec](https://example.com/riverbend/spec)' }],
    });
    expect(
      findInventedLinks([edit('- Read [the spec](https://example.com/riverbend/spec).')], given),
    ).toEqual([]);
  });

  test("a speaker tag is this pipeline's own writing, not a citation", () => {
    expect(
      findInventedLinks([edit('- [@Devi](speaker:B?t=10,12) wants it moved.')], sources()),
    ).toEqual([]);
  });

  test('CONTROL: the same row under a different path is still invented', () => {
    const given = notesLinkSources({ references: [{ url: ROW }] });
    expect(
      findInventedLinks([edit('- [Riverbend gate](/workspaces/w-riverbend?task=t-43)')], given),
    ).toEqual(['/workspaces/w-riverbend?task=t-43']);
  });
});

describe('what the rule leaves alone', () => {
  test('markdown with no links is returned untouched, object and all', () => {
    const one = edit('- The gate moves before merge, Devi to confirm.');
    const out = stripInventedLinks([one], sources());
    expect(out.dropped).toEqual([]);
    expect(out.edits[0]).toBe(one);
  });

  test('an edit carrying no markdown passes through', () => {
    const del: prose.BlockEdit = { op: 'delete_block', blockId: 'blk-9' };
    const out = stripInventedLinks([del], sources());
    expect(out.edits[0]).toBe(del);
    expect(out.dropped).toEqual([]);
  });
});

/* ===== The applier path ===== */

const AUTHOR_DOC = '## Meeting notes\n\n- an earlier point\n';

function meetingWithSection(): {
  store: NotesDocStore;
  memory: NotesHeadingMemory;
} {
  const ydoc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), AUTHOR_DOC);
  const store = oneDocStore('d', { ydoc, meta: { type: 'markdown' as DocType } });
  return { store, memory: createNotesHeadingMemory() };
}

function tick(edits: prose.BlockEdit[], linkSources?: NotesLinkSources): NotesUpdate {
  return {
    docId: 'd',
    meetingId: 'm-1',
    tick: { tick: 1, reason: 'pause', turns: [{ turn: 0, text: 'we should archive that' }] },
    edits,
    ...(linkSources ? { linkSources } : {}),
  };
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
  // A test that replaced `console.log` and threw would otherwise take the
  // rest of the file's output with it.
  expect(typeof console.log).toBe('function');
});

describe('the applier drops the link and says how many', () => {
  test('an invented link never reaches the doc, and is logged once with a count', () => {
    const { store, memory } = meetingWithSection();
    const lines = captureLog(() => {
      expect(
        applyNotesUpdate(
          store,
          tick(
            [
              {
                op: 'insert_at_end',
                markdown: `- Devi cited [the archive](${ARCHIVE}) on the gate.`,
              },
            ],
            notesLinkSources({ references: [{ url: ROW }] }),
          ),
          memory,
        ),
      ).toBe(null);
    });
    const doc = store.get('d');
    if (!doc) throw new Error('the fixture lost its doc');
    const markdown = prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
    expect(markdown).toContain('Devi cited the archive on the gate.');
    expect(markdown).not.toContain('web.archive.org');
    const said = lines.filter((l) => l.includes('invented'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('dropped 1 invented link');
    expect(said[0]).toContain(ARCHIVE);
  });

  test('CONTROL: a link the tick WAS given reaches the doc and logs nothing', () => {
    const { store, memory } = meetingWithSection();
    const lines = captureLog(() => {
      applyNotesUpdate(
        store,
        tick(
          [{ op: 'insert_at_end', markdown: `- Filed as [Riverbend gate](${ROW}).` }],
          notesLinkSources({ references: [{ url: ROW }] }),
        ),
        memory,
      );
    });
    const doc = store.get('d');
    if (!doc) throw new Error('the fixture lost its doc');
    expect(prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc))).toContain(ROW);
    expect(lines.filter((l) => l.includes('invented'))).toHaveLength(0);
  });

  test('a citation already in the notes survives being re-emitted', () => {
    // The regroup case: a later tick rewrites a bullet composed earlier,
    // carrying the link that earlier tick was given. This tick was given
    // nothing, and the doc is the only evidence the link was ever legitimate.
    const ydoc = new Y.Doc();
    prose.applyMarkdownToFragment(
      prose.getProseFragment(ydoc),
      `## Meeting notes\n\n- Filed as [Riverbend gate](${ROW}).\n`,
    );
    prose.ensureBlockIds(ydoc);
    // The note-taker's own blocks, or the applier turns the rewrite into a
    // suggestion and leaves the original bullet — link and all — standing,
    // which would pass this assertion without the rule ever running.
    for (const el of prose.addressableBlocks(prose.getProseFragment(ydoc))) {
      prose.claimSubtree(el, NOTES_AUTHOR_ID);
    }
    const store = oneDocStore('d', { ydoc, meta: { type: 'markdown' as DocType } });
    const bullet = prose.readOutline(ydoc).find((e) => e.kind !== 'heading');
    if (!bullet) throw new Error('the fixture has no bullet');
    const out = applyNotesUpdate(
      store,
      tick(
        [
          {
            op: 'replace_block',
            blockId: bullet.id,
            markdown: `- Filed as [Riverbend gate](${ROW}), Devi to confirm.`,
          },
        ],
        notesLinkSources({}),
      ),
      createNotesHeadingMemory(),
    );
    expect(out).toBe(null);
    const after = prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
    expect(after).toContain('Devi to confirm');
    expect(after).toContain(ROW);
  });

  test('CONTROL: an update with no sources at all judges nothing', () => {
    // Absent means "this caller cannot say", not "the tick was given
    // nothing" — the section-open write is in exactly that position.
    const { store, memory } = meetingWithSection();
    applyNotesUpdate(
      store,
      tick([{ op: 'insert_at_end', markdown: `- [the archive](${ARCHIVE})` }]),
      memory,
    );
    const doc = store.get('d');
    if (!doc) throw new Error('the fixture lost its doc');
    expect(prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc))).toContain(
      'web.archive.org',
    );
  });
});
