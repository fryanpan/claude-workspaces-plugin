/**
 * A SECOND recording into a doc a meeting has already written notes in.
 *
 * The everyday shape of it is stop-and-restart: somebody ends the meeting and
 * starts it again ten minutes later. The owner's rule (2026-09-11) is that
 * the second recording CONTINUES the section the first one wrote, and the
 * older half of it (2026-08-31) is that it never replaces what is already
 * written — which authorship, not the section, is what protects. The awkward
 * shape is two recordings live at once on one doc, which the huddle surface
 * allows, and those keep their sections apart.
 *
 * Both are the same two facts, and this file is about the seam between them:
 *
 * - AUTHORSHIP IS PER DOC, because the note-taker's author id is one constant
 *   for every meeting. Meeting two must not read meeting one's bullets as its
 *   own — the note-taking prompt invites deleting your own bullets when
 *   regrouping a topic, and `applyBlockEdits` carries that out directly.
 * - THE SECTION IS PER MEETING, because a section is what one recording wrote.
 *   Keyed by doc alone, the memory cross-wired: the second meeting's start
 *   wiped the first's, so the first's next tick adopted the second's heading
 *   or opened a third section.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { prose, suggestOps } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { createNotesHeadingMemory } from '../src/meeting-notes-doc.ts';

import { markdownOfDoc } from './notes-doc-helpers.ts';
import { addNotes, createNotesTickHarness, SCRIPT_TOPIC } from './notes-tick-harness.ts';

/** The block id of the outline entry whose text holds `needle`. */
const idOf = (input: { outline: readonly prose.OutlineEntry[] }, needle: string): string => {
  const found = input.outline.find((e) => e.text.includes(needle));
  if (!found) throw new Error(`no outline entry holding ${needle}`);
  return found.id;
};

describe('a second meeting recording into one doc', () => {
  it('may propose on the first meeting’s notes but never delete them', async () => {
    // THE DATA LOSS THIS REPLACED: `onSessionStart` forgot the heading id and
    // nothing else, so every block meeting one wrote still carried the
    // note-taker's author id. Meeting two's outline showed them as "yours",
    // and a delete_block on one was applied directly — a hard delete of notes
    // a person had already read.
    const heading = createNotesHeadingMemory();
    const ydoc = new Y.Doc();
    const first = createNotesTickHarness({
      ydoc,
      heading,
      meetingId: 'm1',
      compose: (input) => addNotes(input, '- the export dialog forgets the range'),
    });
    await first.speak('the export dialog forgets the range');
    await first.end();
    expect(markdownOfDoc(ydoc)).toContain('the export dialog forgets the range');

    const second = createNotesTickHarness({
      ydoc,
      heading,
      meetingId: 'm2',
      compose: (input) => [{ op: 'delete_block', blockId: idOf(input, 'export dialog') }],
    });
    await second.speak('scrap that dialog point');

    // Still there, word for word, and now a proposal somebody can look at.
    expect(markdownOfDoc(ydoc)).toContain('the export dialog forgets the range');
    expect(suggestOps.listSuggestions(ydoc).length).toBeGreaterThan(0);
  });

  it('a replace of the first meeting’s bullet arrives as a suggestion', async () => {
    const heading = createNotesHeadingMemory();
    const ydoc = new Y.Doc();
    const first = createNotesTickHarness({
      ydoc,
      heading,
      meetingId: 'm1',
      compose: (input) => addNotes(input, '- shipping on Thursday'),
    });
    await first.speak('we are shipping on Thursday');
    await first.end();

    const second = createNotesTickHarness({
      ydoc,
      heading,
      meetingId: 'm2',
      compose: (input) => [
        {
          op: 'replace_block',
          blockId: idOf(input, 'shipping on Thursday'),
          markdown: '- shipping whenever',
        },
      ],
    });
    await second.speak('actually who knows when we ship');

    expect(markdownOfDoc(ydoc)).toContain('shipping on Thursday');
    expect(suggestOps.listSuggestions(ydoc).length).toBeGreaterThan(0);
  });

  it('each meeting keeps writing under its own section heading', async () => {
    // Keyed by doc alone, the second meeting's start wiped the first's memory
    // and then wrote its own heading into the same slot, so the first
    // meeting's next tick was told to write under the SECOND meeting's
    // section. Both meetings' notes ended up in one place.
    const heading = createNotesHeadingMemory();
    const ydoc = new Y.Doc();
    const seenByFirst: Array<string | undefined> = [];
    const first = createNotesTickHarness({
      ydoc,
      heading,
      meetingId: 'm1',
      compose: (input, tick) => {
        seenByFirst.push(input.notesHeadingId);
        return addNotes(input, `- first meeting point ${tick}`);
      },
    });
    await first.speak('point one');

    const second = createNotesTickHarness({
      ydoc,
      heading,
      meetingId: 'm2',
      compose: (input) => addNotes(input, '- second meeting point'),
    });
    await second.speak('a different room');

    // Two sections, one per recording.
    expect(first.countHeadings(SCRIPT_TOPIC)).toBe(2);

    await first.speak('point two');
    expect(first.countHeadings(SCRIPT_TOPIC)).toBe(2);

    const outline = prose.readOutline(ydoc);
    const sections = outline.filter((e) => e.text === SCRIPT_TOPIC);
    expect(sections).toHaveLength(2);
    // The first meeting's second tick was told to write under the FIRST
    // section, not the one the other meeting had just opened.
    expect(seenByFirst[0]).toBeUndefined();
    expect(seenByFirst[1]).toBe(sections[0]?.id as string);
    // And its bullet landed above the second meeting's heading.
    const at = (needle: string): number => outline.findIndex((e) => e.text.includes(needle));
    expect(at('first meeting point 2')).toBeLessThan(outline.indexOf(sections[1] as never));
  });
});

describe('a tick the composer had nothing to say about', () => {
  it('is a covered tick, not a failed compose', async () => {
    // An empty edit list is a legitimate answer — a tick of greetings changes
    // nothing. It must not reach the summary as a compose failure, and its
    // turns must not be carried into the next tick as if they had been lost.
    const carried: number[] = [];
    const harness = createNotesTickHarness({
      compose: (input, tick) => {
        carried.push(input.tick.turns.length);
        return tick === 1 ? [] : addNotes(input, '- the retry ticket is next');
      },
    });
    await harness.speak('morning everyone');
    await harness.speak('the retry ticket is next');
    await harness.end();

    const summary = harness.summary();
    expect(summary?.composeFailures).toBe(0);
    expect(summary?.turnsLost).toBe(0);
    // The greeting was settled by its own tick, so the second tick saw only
    // what the second tick heard.
    expect(carried).toEqual([1, 1]);
    expect(harness.errors).toEqual([]);
  });
});

/**
 * A DOC THAT ALREADY HAS HEADINGS WHEN A RECORDING STARTS.
 *
 * Two questions, and only the record answers either. A heading SOME MEETING
 * WROTE is the minutes, and a recording started soon after that meeting
 * stopped carries on under it — the 2026-09-11 rule, from the day Bryan
 * stopped a recording, started another minutes later, and got a second
 * heading at the bottom of the page. A heading NOBODY recorded is the
 * document's own: this meeting leaves it alone and starts a topic of its own,
 * which is the 2026-09-15 rule that removed the reserved section.
 */
describe('a meeting arriving at a doc that already has headings', () => {
  it('leaves a heading no meeting wrote alone, and starts its own topic', async () => {
    const harness = createNotesTickHarness({
      doc: `# Standup\n\n## ${SCRIPT_TOPIC}\n`,
      compose: (input, tick) =>
        addNotes(
          input,
          tick === 1 ? '- the Riverbend import runs twice' : '- and it double-charges Harborlight',
          'Riverbend import',
        ),
    });
    const first = await harness.speak('the Riverbend import runs twice');
    // The doc's own heading is untouched; the meeting wrote its own topic.
    expect(first.headings.filter((h) => h === SCRIPT_TOPIC)).toHaveLength(1);
    expect(first.headings).toContain('Riverbend import');
    expect(first.input?.notesHeadingId).toBeUndefined();

    // And it keeps that topic for the rest of the meeting rather than opening
    // a second one on every tick.
    const second = await harness.speak('and it double-charges Harborlight');
    expect(second.headings.filter((h) => h === 'Riverbend import')).toHaveLength(1);
    expect(second.markdown).toContain('double-charges Harborlight');
    expect(second.input?.notesHeadingId).toBeTruthy();
  });

  it('a heading the PREVIOUS RECORDING wrote and stopped under is continued', async () => {
    // The earlier meeting's words are untouched by it —
    // `releaseNotesAuthorship` has dropped every claim, so the new recording
    // can only propose on them — which is what the 2026-08-31 rule was
    // protecting and what continuing the section does not cost.
    const heading = createNotesHeadingMemory();
    const ydoc = new Y.Doc();
    const before = createNotesTickHarness({
      ydoc,
      heading,
      meetingId: 'm-prev',
      doc: '# Standup\n',
      compose: (input) => addNotes(input, '- last week: the tunnel flapped'),
    });
    await before.speak('last week the tunnel flapped');
    await before.end();

    const harness = createNotesTickHarness({
      ydoc,
      heading,
      meetingId: 'm1',
      compose: (input) => addNotes(input, '- the Riverbend import runs twice'),
    });
    const snap = await harness.speak('the Riverbend import runs twice');
    expect(snap.headings.filter((h) => h === SCRIPT_TOPIC)).toHaveLength(1);
    expect(snap.notes).toContain('last week: the tunnel flapped');
    expect(snap.notes).toContain('the Riverbend import runs twice');
  });

  it('MUTATION CONTROL: the previous recording still RUNNING keeps its heading', async () => {
    // The same two meetings, one stop short. A claim says whose the section
    // is while the meeting is going, so a second room recording into the
    // same doc still starts its own — and that is the only thing separating
    // the two cases.
    const heading = createNotesHeadingMemory();
    const ydoc = new Y.Doc();
    const before = createNotesTickHarness({
      ydoc,
      heading,
      meetingId: 'm-prev',
      doc: '# Standup\n',
      compose: (input) => addNotes(input, '- last week: the tunnel flapped'),
    });
    await before.speak('last week the tunnel flapped');

    const harness = createNotesTickHarness({
      ydoc,
      heading,
      meetingId: 'm1',
      compose: (input) => addNotes(input, '- the Riverbend import runs twice'),
    });
    const snap = await harness.speak('the Riverbend import runs twice');
    expect(snap.headings.filter((h) => h === SCRIPT_TOPIC)).toHaveLength(2);
    expect(snap.markdown).toContain('last week: the tunnel flapped');
    expect(snap.markdown).toContain('the Riverbend import runs twice');
  });

  it('MUTATION CONTROL: the same doc with no record behind it is never joined', async () => {
    // Same markdown, same heading, same bullet — written into the doc rather
    // than by a meeting. Without this pair the case above would be measuring
    // "a heading with words under it" rather than "a heading a meeting
    // claimed".
    const harness = createNotesTickHarness({
      doc: `# Standup\n\n## ${SCRIPT_TOPIC}\n\n- last week: the tunnel flapped\n`,
      compose: (input) => addNotes(input, '- the Riverbend import runs twice', 'Riverbend import'),
    });
    const snap = await harness.speak('the Riverbend import runs twice');
    expect(snap.headings.filter((h) => h === SCRIPT_TOPIC)).toHaveLength(1);
    expect(snap.headings).toContain('Riverbend import');
    const md = snap.markdown;
    expect(md.indexOf('the tunnel flapped')).toBeLessThan(md.indexOf('Riverbend import'));
  });
});
