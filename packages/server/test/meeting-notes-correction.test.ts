/**
 * Correcting a note out loud: which note the words resolve to, what happens
 * when they resolve to nobody's or to two, and the line the correction may
 * never cross — a note a person wrote is proposed on, never overwritten.
 *
 * The integration half runs the REAL notes-doc path — `applyNotesUpdate` to
 * write notes and stock the ownership ledger, `applyNotesCorrection` to
 * correct them — rather than a stub that agrees with everything. A recorder
 * that says ok to every call cannot tell a correction that landed from one
 * that did nothing (the #512 lesson), and the whole feature is about which of
 * those happened.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { type DocType, prose, suggestOps } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  correctNotesSection,
  correctionPhraseUsable,
  correctionSpokenOnTick,
  phraseSites,
} from '../src/meeting-notes-correction.ts';
import {
  MEETING_NOTES_HEADING,
  applyNotesCorrection,
  applyNotesUpdate,
  createNotesHeadingMemory,
} from '../src/meeting-notes-doc.ts';
import type { NotesCorrection, NotesUpdate } from '../src/meeting-notes.ts';
import { agentNotesDoc, asPerson, oneDocStore } from './notes-doc-helpers.ts';

function docFrom(markdown: string): Y.Doc {
  const ydoc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), markdown);
  return ydoc;
}

const NOTES = (body: string): string => `# Huddle\n\n## ${MEETING_NOTES_HEADING}\n\n${body}`;

function markdownOf(ydoc: Y.Doc): string {
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
}

/** The doc's words with no markup at all — what a reader actually sees, and
 *  the only view in which a pending suggestion's text is visible. */
function plainTextOf(ydoc: Y.Doc): string {
  return prose.locateMatches(prose.getProseFragment(ydoc), { find: '' }).plainText;
}

/**
 * WHOSE NOTE IT IS, NOW THAT THERE IS NO LEDGER.
 *
 * The correction used to ask an ownership ledger which items were the agent's;
 * it reads the block's `cwAuthor` instead. So a fixture built by parsing
 * markdown is a doc full of NOBODY's notes — which is the person case, not the
 * agent one — and the agent case has to be written the way production writes
 * it, through `applyBlockEdits`. These two builders are that distinction,
 * spelled once.
 */
const agentNote = (body: string): Y.Doc =>
  agentNotesDoc('# Huddle\n', `## ${MEETING_NOTES_HEADING}\n\n${body}`);

/** The same section, written by a person: no authorship on anything. */
const personNote = (body: string): Y.Doc => docFrom(NOTES(body));

/** Add a bullet of a person's own to the end of the doc's first list. */
function personAdds(ydoc: Y.Doc, line: string): void {
  const list = (prose.getProseFragment(ydoc).toArray() as Y.XmlElement[]).find(
    (el) => el.nodeName === 'bulletList',
  ) as Y.XmlElement;
  const li = new Y.XmlElement('listItem');
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  li.insert(0, [p]);
  p.insert(0, [t]);
  asPerson(ydoc, () => {
    list.insert(list.length, [li]);
    prose.insertTextWithMarks(t, 0, line, {});
  });
}

/** A person rewriting the first bullet in their own words, which is what
 *  clears its authorship. */
function personRewritesFirst(ydoc: Y.Doc, line: string): void {
  const list = (prose.getProseFragment(ydoc).toArray() as Y.XmlElement[]).find(
    (el) => el.nodeName === 'bulletList',
  ) as Y.XmlElement;
  const li = list.toArray()[0] as Y.XmlElement;
  const text = (li.toArray()[0] as Y.XmlElement).toArray()[0] as Y.XmlText;
  asPerson(ydoc, () => {
    text.delete(0, text.length);
    prose.insertTextWithMarks(text, 0, line, { parseInlineMarks: true });
  });
}

describe('phraseSites', () => {
  it('finds whole tokens only, so a correction cannot reach inside a word', () => {
    // "ten" is in "attention" and in "often" — neither is the word anybody
    // corrected, and rewriting them would mangle a sentence.
    expect(phraseSites('we often pay attention to ten things', 'ten')).toEqual([26]);
  });

  it('matches case-insensitively, because speech and notes capitalise apart', () => {
    expect(phraseSites('Ship on Tuesday', 'tuesday')).toEqual([8]);
    expect(phraseSites('ship on tuesday', 'Tuesday')).toEqual([8]);
  });

  it('finds every occurrence, and none at all for a phrase that is absent', () => {
    expect(phraseSites('Tuesday, then Tuesday again', 'Tuesday')).toEqual([0, 14]);
    expect(phraseSites('Ship on Tuesday', 'Thursday')).toEqual([]);
  });

  it('treats an accented letter as part of a word, in any script', () => {
    // Found by codex review. The rename's ASCII boundary reads "n~" as a
    // boundary, so correcting "ana" would rewrite the tail of "manana"
    // written with the tilde. The positive control is the second assertion:
    // the same phrase standing on its own IS found.
    expect(phraseSites('lo hacemos ma\u00f1ana entonces', 'ana')).toEqual([]);
    expect(phraseSites('ana will run it ma\u00f1ana', 'ana')).toEqual([0]);
    // ...and with the same letter written decomposed (n + combining tilde).
    expect(phraseSites('lo hacemos man\u0303ana entonces', 'ana')).toEqual([]);
    // Cyrillic, where every letter is outside [A-Za-z0-9].
    expect(
      phraseSites('\u043f\u043e\u0440\u0430 \u0434\u043e\u043c\u043e\u0439', '\u043e\u0440\u0430'),
    ).toEqual([]);
  });

  it('handles a multi-word phrase with punctuation in it', () => {
    // A plain scan, not a RegExp: the dot would be a wildcard in a pattern.
    expect(phraseSites('due by v1.2 at the latest', 'v1.2')).toEqual([7]);
  });
});

describe('correctionSpokenOnTick', () => {
  const turns = [
    { text: 'Let us lock the review for Tuesday then.' },
    { text: 'No, I said Thursday.' },
  ];

  it('vouches for words the tick actually carried', () => {
    expect(correctionSpokenOnTick(turns, 'Thursday')).toBe(true);
  });

  it('refuses words nobody said — the invented-correction guard', () => {
    // The positive control is the assertion above: the same call on the same
    // turns says yes for a phrase that IS there, so a "no" here is the guard
    // working rather than the helper being unable to answer.
    expect(correctionSpokenOnTick(turns, 'Saturday')).toBe(false);
  });

  it('does not accept a phrase that only appears inside a longer word', () => {
    expect(correctionSpokenOnTick([{ text: 'the reviewer signed off' }], 'review')).toBe(false);
  });
});

describe('correctionPhraseUsable', () => {
  it('refuses a phrase too short to identify a note', () => {
    expect(correctionPhraseUsable('on')).toBe(false);
    expect(correctionPhraseUsable('  a ')).toBe(false);
    expect(correctionPhraseUsable('Tue')).toBe(true);
  });

  it('refuses a sentence — that is a rewrite, not a correction', () => {
    expect(correctionPhraseUsable('x'.repeat(61))).toBe(false);
  });
});

describe('correctNotesSection', () => {
  const correct = (ydoc: Y.Doc, wrong: string, right: string) =>
    correctNotesSection(ydoc, { wrong, right });

  it('rewrites the agent note the words point at, and nothing else in it', () => {
    const ydoc = agentNote('- Ship the gate on Tuesday, ahead of the review.\n');
    const res = correct(ydoc, 'Tuesday', 'Thursday');
    expect(res).toEqual({ applied: 'revised', sites: 1 });
    expect(markdownOf(ydoc)).toContain('- Ship the gate on Thursday, ahead of the review.');
  });

  it('adds no second note — the whole point of the intent', () => {
    const ydoc = agentNote('- Ship the gate on Tuesday.\n');
    correct(ydoc, 'Tuesday', 'Thursday');
    const md = markdownOf(ydoc);
    expect(md.split('- Ship the gate').length).toBe(2); // exactly one bullet
    expect(md).not.toContain('Tuesday');
  });

  it('matches the note case-insensitively and writes the words as spoken', () => {
    const ydoc = agentNote('- Ship on tuesday.\n');
    expect(correct(ydoc, 'Tuesday', 'Thursday').applied).toBe('revised');
    expect(markdownOf(ydoc)).toContain('- Ship on Thursday.');
  });

  it('two agent notes carrying the phrase is ambiguous, and nothing moves', () => {
    // Which one did they mean? Fixing the newest leaves a stale one behind
    // and the choice looks arbitrary; fixing both is a wider edit than two
    // spoken words asked for. So: neither.
    const ydoc = agentNote('- Ship on Tuesday.\n- Design review Tuesday.\n');
    const res = correct(ydoc, 'Tuesday', 'Thursday');
    expect(res).toEqual({ applied: 'none', reason: 'ambiguous' });
    const md = markdownOf(ydoc);
    expect(md).toContain('- Ship on Tuesday.');
    expect(md).toContain('- Design review Tuesday.');
    expect(md).not.toContain('Thursday');
  });

  it('corrects every occurrence WITHIN the one note it resolved to', () => {
    // Two sites in one bullet are the same mistake said twice, not two notes.
    const ydoc = agentNote('- Tuesday for the gate, and Tuesday for the review.\n');
    const res = correct(ydoc, 'Tuesday', 'Thursday');
    expect(res).toEqual({ applied: 'revised', sites: 2 });
    expect(markdownOf(ydoc)).toContain('- Thursday for the gate, and Thursday for the review.');
  });

  it('a phrase in no note does nothing — the ordinary answer for a misheard ask', () => {
    const ydoc = agentNote('- Ship the gate on Tuesday.\n');
    const res = correct(ydoc, 'Wednesday', 'Thursday');
    expect(res).toEqual({ applied: 'none', reason: 'no-match' });
    expect(markdownOf(ydoc)).toContain('Tuesday');
  });

  it('a doc with nothing written in it says so rather than writing one', () => {
    // WHAT CHANGED. `no-section` used to mean "no `## Meeting notes` heading";
    // the correction no longer looks for a heading at all, so it now means
    // the doc holds no addressable block to correct. A doc that DOES hold
    // prose but not the phrase is the ordinary miss, `no-match` — the two
    // used to be the same answer and are now told apart.
    expect(correct(docFrom(''), 'Tuesday', 'Thursday')).toEqual({
      applied: 'none',
      reason: 'no-section',
    });
    const typed = docFrom('# Huddle\n\nSome agenda a person typed.\n');
    expect(correct(typed, 'Tuesday', 'Thursday')).toEqual({
      applied: 'none',
      reason: 'no-match',
    });
    expect(markdownOf(typed)).not.toContain('Thursday');
  });

  it('lands on the right characters after a letter that changes length when lowered', () => {
    // `\u0130`.toLowerCase() is TWO code units, so a lowercased copy of the
    // note is no longer index-aligned with the note itself. Matching on that
    // copy drifts every offset after it, and the drift is not a miss — it is
    // a delete one character to the right of the word.
    const ydoc = agentNote('- \u0130stanbul ships on Tuesday.\n');
    expect(correct(ydoc, 'Tuesday', 'Thursday').applied).toBe('revised');
    expect(markdownOf(ydoc)).toContain('\u0130stanbul ships on Thursday.');
  });

  it('a note of its own outranks every line of the person’s prose', () => {
    // THE SAFETY PROPERTY, RESTATED. It used to be geometric — the correction
    // could only see inside the notes section, so prose above and below was
    // out of reach by construction. It is now about authorship: a block the
    // agent wrote wins outright, and the person's lines are not even
    // candidates while one exists. Same protection, and it now follows the
    // note if a person moves it out of the section.
    const ydoc = agentNotesDoc(
      ['# Agenda', '', 'We meet on Tuesday.', ''].join('\n'),
      `## ${MEETING_NOTES_HEADING}\n\n- Ship on Tuesday.`,
    );
    asPerson(ydoc, () => {
      const t = new Y.XmlText();
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [t]);
      prose.getProseFragment(ydoc).insert(prose.getProseFragment(ydoc).length, [p]);
      prose.insertTextWithMarks(t, 0, 'Tuesday again, in my own words.', {});
    });
    expect(correct(ydoc, 'Tuesday', 'Thursday')).toEqual({ applied: 'revised', sites: 1 });
    const md = markdownOf(ydoc);
    expect(md).toContain('- Ship on Thursday.');
    expect(md).toContain('We meet on Tuesday.');
    expect(md).toContain('Tuesday again, in my own words.');
  });

  it('with no note of its own, two lines of the person’s prose are a guess', () => {
    // And the drop is what keeps the widening safe: reaching the person's
    // words at all is only ever a SUGGESTION on exactly one line, never a
    // pick between two.
    const ydoc = docFrom(
      ['# Agenda', '', 'We meet on Tuesday.', '', '## Next steps', '', '- Tuesday again.', ''].join(
        '\n',
      ),
    );
    expect(correct(ydoc, 'Tuesday', 'Thursday')).toEqual({ applied: 'none', reason: 'ambiguous' });
    const md = markdownOf(ydoc);
    expect(md).toContain('We meet on Tuesday.');
    expect(md).toContain('- Tuesday again.');
  });

  it('refuses a site inside a speaker tag — attribution does not move this way', () => {
    // Rewriting the tag's text while its href still names voice B would leave
    // the tag claiming B is called something B is not. Attribution moves by
    // the reassign gesture; never by a correction of the words around it.
    const ydoc = agentNote('- [@Marisol](speaker:B) will run the gate.\n');
    const res = correct(ydoc, 'Marisol', 'Priya');
    expect(res).toEqual({ applied: 'none', reason: 'attribution' });
    const md = markdownOf(ydoc);
    expect(md).toContain('[@Marisol](speaker:B)');
    expect(md).not.toContain('Priya');
  });

  it('still corrects the words BESIDE a tag, in the same note', () => {
    // The positive control for the test above: the tag is off limits, the
    // sentence around it is not.
    const ydoc = agentNote('- [@Marisol](speaker:B) will ship it on Tuesday.\n');
    expect(correct(ydoc, 'Tuesday', 'Thursday').applied).toBe('revised');
    const md = markdownOf(ydoc);
    expect(md).toContain('[@Marisol](speaker:B)');
    expect(md).toContain('on Thursday.');
  });

  // A tag now carries the turns it was composed from — `speaker:B?t=10,12`,
  // and `&unsure=1` when the engine could not place them. That provenance is
  // what a late reattribution reads to decide which mentions move, so a
  // correction has to leave it exactly as it found it. The first of these is
  // the control: if the href with a query did not parse as a tag at all, the
  // refusal would not fire and the test would fail rather than pass emptily.
  it('refuses a site inside a tag that carries its turns', () => {
    const ydoc = agentNote('- [@Marisol](speaker:B?t=10,12) will run the gate.\n');
    const res = correct(ydoc, 'Marisol', 'Priya');
    expect(res).toEqual({ applied: 'none', reason: 'attribution' });
    expect(markdownOf(ydoc)).toContain('[@Marisol](speaker:B?t=10,12)');
  });

  it('leaves a turn-carrying href intact when it revises the words beside it', () => {
    const ydoc = agentNote('- [@Marisol](speaker:B?t=10,12) will ship it on Tuesday.\n');
    expect(correct(ydoc, 'Tuesday', 'Thursday').applied).toBe('revised');
    const md = markdownOf(ydoc);
    // Whole href, not a truncation of it: a mention that lost `?t=` still
    // reads as a tag and can never be moved again.
    expect(md).toContain('[@Marisol](speaker:B?t=10,12)');
    expect(md).toContain('on Thursday.');
    // And the words the correction wrote did not inherit the link.
    expect(md).not.toContain('[Thursday]');
  });

  it('writes the new words in the formatting the old ones wore', () => {
    // The other half of the mark question: a correction that landed inside
    // emphasis has to come out inside it, or the note loses the mark a
    // person put there. Replacing the whole emphasised word is the case
    // where a plain insert quietly drops it.
    const ydoc = agentNote('- We ship on **Tuesday** for sure.\n');
    expect(correct(ydoc, 'Tuesday', 'Thursday').applied).toBe('revised');
    expect(markdownOf(ydoc)).toContain('**Thursday**');
  });

  it('does not let the tag bleed onto a word written right after it', () => {
    // The adjacency that actually risks it: the corrected word begins where
    // the link ends, so an insert that inherited the left neighbour's marks
    // would swallow the new word into the tag — a mention naming a day.
    const ydoc = agentNote('- [@Marisol](speaker:B?t=10,12) Tuesday is the day.\n');
    expect(correct(ydoc, 'Tuesday', 'Thursday').applied).toBe('revised');
    const md = markdownOf(ydoc);
    expect(md).toContain('[@Marisol](speaker:B?t=10,12) Thursday is the day.');
    expect(md).not.toContain('Thursday](speaker:');
  });

  it('keeps an unsure tag unsure — a revision says nothing about who spoke', () => {
    const ydoc = agentNote('- [@Marisol](speaker:B?t=10,12&unsure=1) ships on Tuesday.\n');
    expect(correct(ydoc, 'Tuesday', 'Thursday').applied).toBe('revised');
    expect(markdownOf(ydoc)).toContain('[@Marisol](speaker:B?t=10,12&unsure=1)');
  });
});

describe('correctNotesSection — a person’s note', () => {
  it('proposes on it instead of overwriting it', () => {
    // AC2. Nothing in this doc carries the agent's authorship, so every item
    // reads as a person's.
    const ydoc = personNote('- My own line: the gate ships Tuesday.\n');
    const res = correctNotesSection(ydoc, {
      wrong: 'Tuesday',
      right: 'Thursday',
    });
    expect(res).toEqual({ applied: 'suggested' });

    // The ACCEPTED text is untouched: their words still say what they wrote.
    expect(markdownOf(ydoc)).toContain('- My own line: the gate ships Tuesday.');
    // And the proposal is really there, as a redline they can answer.
    expect(plainTextOf(ydoc)).toContain('Thursday');
    const pending = suggestOps.scanSuggestions(prose.getProseFragment(ydoc));
    expect(pending.size).toBe(1);
  });

  it('proposes on a note the AGENT wrote and the person then edited', () => {
    // The doc clears `cwAuthor` the moment a person edits the block, so a
    // bullet they have rewritten is theirs from then on. The correction
    // proposes.
    const ydoc = agentNote('- Ship the gate on Tuesday.\n');
    personRewritesFirst(ydoc, 'MY wording: the gate ships Tuesday');

    const res = correctNotesSection(ydoc, {
      wrong: 'Tuesday',
      right: 'Thursday',
    });
    expect(res).toEqual({ applied: 'suggested' });
    expect(markdownOf(ydoc)).toContain('MY wording: the gate ships Tuesday');
  });

  it('the agent’s own note wins when both carry the phrase, and theirs is untouched', () => {
    const ydoc = agentNote('- Ship the gate on Tuesday.\n');
    // A person adds a line of their own that happens to say Tuesday too.
    personAdds(ydoc, 'I am away Tuesday, for what it is worth');

    const res = correctNotesSection(ydoc, {
      wrong: 'Tuesday',
      right: 'Thursday',
    });
    expect(res).toEqual({ applied: 'revised', sites: 1 });
    const md = markdownOf(ydoc);
    expect(md).toContain('- Ship the gate on Thursday.');
    expect(md).toContain('- I am away Tuesday, for what it is worth');
    expect(suggestOps.scanSuggestions(prose.getProseFragment(ydoc)).size).toBe(0);
  });

  it('does not stack a second redline on a proposal they have not answered', () => {
    // One pending proposal per item at a time: somebody who has not answered
    // the first must not collect a fresh one every tick. A DIFFERENT phrase,
    // so the guard is doing the work rather than the boundary rule below.
    const ydoc = personNote('- My line: the gate ships Tuesday, owner Marcus.\n');
    expect(
      correctNotesSection(ydoc, {
        wrong: 'Tuesday',
        right: 'Thursday',
      }).applied,
    ).toBe('suggested');
    const second = correctNotesSection(ydoc, {
      wrong: 'Marcus',
      right: 'Priya',
    });
    expect(second).toEqual({ applied: 'none', reason: 'unsuggestable' });
    expect(suggestOps.scanSuggestions(prose.getProseFragment(ydoc)).size).toBe(1);
  });

  it('will not re-propose the same correction, because it reads as already made', () => {
    // A pending redline leaves the accepted word and the proposed one flush
    // against each other ("TuesdayThursday"), so the whole-token rule finds
    // no "Tuesday" to correct on the next tick. Belt to the guard's braces —
    // and the reason is the honest one: the note no longer spells the phrase.
    const ydoc = personNote('- My line: the gate ships Tuesday.\n');
    const ask = { wrong: 'Tuesday', right: 'Thursday' };
    expect(correctNotesSection(ydoc, ask).applied).toBe('suggested');
    expect(correctNotesSection(ydoc, ask)).toEqual({
      applied: 'none',
      reason: 'no-match',
    });
    expect(suggestOps.scanSuggestions(prose.getProseFragment(ydoc)).size).toBe(1);
  });

  it('two of a person’s notes carrying the phrase is ambiguous too', () => {
    const ydoc = personNote('- My line about Tuesday.\n- My other line about Tuesday.\n');
    const res = correctNotesSection(ydoc, {
      wrong: 'Tuesday',
      right: 'Thursday',
    });
    expect(res).toEqual({ applied: 'none', reason: 'ambiguous' });
    expect(suggestOps.scanSuggestions(prose.getProseFragment(ydoc)).size).toBe(0);
  });
});

describe('applyNotesCorrection — through the real notes-doc path', () => {
  const storeWith = (docId: string, type: DocType, ydoc: Y.Doc) => ({
    docStore: oneDocStore(docId, { ydoc, meta: { type } }),
    ydoc,
  });
  const ask = (docId: string, wrong: string, right: string): NotesCorrection => ({
    docId,
    meetingId: 'm-1',
    wrong,
    right,
  });
  const notesUpdate = (docId: string, tick: number, edits: NotesUpdate['edits']): NotesUpdate => ({
    docId,
    meetingId: 'm-1',
    tick: { tick, reason: 'pause', turns: [] },
    edits,
  });

  it('corrects a note the notes pipeline itself wrote, and keeps owning it', () => {
    // The freeze test. The correction edits the agent's own bullet IN PLACE
    // under a string origin, so the block's `cwAuthor` survives — otherwise
    // the note-taker has silently handed that line to the person and the NEXT
    // tick could only propose on it. That is what the replace below proves.
    const { docStore, ydoc } = storeWith('doc-a', 'markdown', docFrom('# Huddle\n'));
    const memory = createNotesHeadingMemory();
    applyNotesUpdate(
      docStore,
      notesUpdate('doc-a', 1, [
        {
          op: 'insert_at_end',
          markdown: `## ${MEETING_NOTES_HEADING}\n\n- Ship the gate on Tuesday.`,
        },
      ]),
      memory,
    );
    expect(applyNotesCorrection(docStore, ask('doc-a', 'Tuesday', 'Thursday'))).toBe('revised');
    expect(markdownOf(ydoc)).toContain('- Ship the gate on Thursday.');

    // Still the agent's: the next tick REVISES the corrected line rather than
    // laying a second one beside it.
    const bullet = docStore
      .readOutline('doc-a')
      ?.blocks.find((b) => b.text.includes('Ship the gate'));
    expect(bullet?.author).toBe('meeting-notes');
    applyNotesUpdate(
      docStore,
      notesUpdate('doc-a', 2, [
        {
          op: 'replace_block',
          blockId: bullet?.id ?? '',
          markdown: '- Ship the gate on Thursday, before the review.',
        },
      ]),
      memory,
    );
    const md = markdownOf(ydoc);
    expect(md).toContain('- Ship the gate on Thursday, before the review.');
    expect(md.split('Ship the gate').length).toBe(2);
    expect(suggestOps.scanSuggestions(prose.getProseFragment(ydoc)).size).toBe(0);
  });

  it('a line the person made theirs is proposed on, not reclaimed by the correction', () => {
    const { docStore, ydoc } = storeWith('doc-a', 'markdown', docFrom('# Huddle\n'));
    applyNotesUpdate(
      docStore,
      notesUpdate('doc-a', 1, [
        {
          op: 'insert_at_end',
          markdown: `## ${MEETING_NOTES_HEADING}\n\n- Ship the gate on Tuesday.`,
        },
      ]),
      createNotesHeadingMemory(),
    );
    personRewritesFirst(ydoc, 'MY wording: gate ships Tuesday');

    expect(applyNotesCorrection(docStore, ask('doc-a', 'Tuesday', 'Thursday'))).toBe('suggested');
    expect(markdownOf(ydoc)).toContain('MY wording: gate ships Tuesday');
  });

  it('a gone doc and a flat doc are both none, never a throw', () => {
    const { docStore } = storeWith('doc-a', 'markdown', agentNote('- Ship on Tuesday.\n'));
    expect(applyNotesCorrection(docStore, ask('doc-gone', 'Tuesday', 'Thursday'))).toBe('none');
    const flat = storeWith('doc-b', 'diff', agentNote('- Ship on Tuesday.\n'));
    expect(applyNotesCorrection(flat.docStore, ask('doc-b', 'Tuesday', 'Thursday'))).toBe('none');
    expect(markdownOf(flat.ydoc)).toContain('Tuesday');
  });

  it('a restarted server still owns what it wrote, because the doc remembers', () => {
    // WHAT CHANGED, AND IT IS A BEHAVIOUR CHANGE. This used to assert the
    // opposite: a fresh ledger claimed nothing, so a correction after a
    // restart could only propose. Authorship lives on the block now, so a
    // note this agent wrote before the restart is still its own to revise.
    // The conservative direction was only ever a consequence of where the
    // answer was kept, and keeping it in the doc is what the rebuild bought.
    const { docStore, ydoc } = storeWith('doc-a', 'markdown', agentNote('- Ship on Tuesday.\n'));
    expect(applyNotesCorrection(docStore, ask('doc-a', 'Tuesday', 'Thursday'))).toBe('revised');
    expect(markdownOf(ydoc)).toContain('- Ship on Thursday.');
  });

  it('but a note nobody signed is still proposed on', () => {
    // The other half, and the one that keeps the change safe: a section a
    // person typed carries no authorship at all, so the correction proposes
    // exactly as it did before.
    const { docStore, ydoc } = storeWith('doc-a', 'markdown', personNote('- Ship on Tuesday.\n'));
    expect(applyNotesCorrection(docStore, ask('doc-a', 'Tuesday', 'Thursday'))).toBe('suggested');
    expect(markdownOf(ydoc)).toContain('- Ship on Tuesday.');
  });
});
