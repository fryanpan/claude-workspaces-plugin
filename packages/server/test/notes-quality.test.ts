/**
 * The decidable half of "did the note-taker behave", driven directly.
 *
 * `notes-quality.ts` exists so that the questions with a right answer —
 * how long a bullet reads, whether a topic was opened twice, whether a topic
 * was left running as a wall of bullets, whether a decision carries the voice
 * that made it, whether a named row was linked, whether a bullet was copied
 * out of the transcript — are settled in code that a unit test can drive,
 * instead of inside `scripts/notes-eval.ts` where only a paid run over real
 * meetings could ever exercise them. This file is that unit test. The eval
 * calls exactly these functions on notes a model wrote; here they are called
 * on notes nobody did.
 *
 * The other half of the behaviour — that the instructions asking for all this
 * reach the model, and that the pipeline keeps its promises whatever the
 * model returns — is `notetaker-behaviour.test.ts`.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import {
  MAX_BULLET_WORDS,
  MAX_FLAT_RUN_BULLETS,
  allBullets,
  bulletWords,
  decisionsWithoutSpeaker,
  duplicateTopics,
  emptyHeadings,
  flatBulletRuns,
  longFlatRuns,
  nestedBullets,
  openedEmptyHeadings,
  overlongBullets,
  parseNotesTopics,
  unlinkedReferences,
  verbatimBullets,
} from '../src/notes-quality.ts';

/* ===== The decidable checks the eval scores with ===== */

describe('the programmatic judges', () => {
  const notes = [
    '### Sync wakes too often',
    '',
    '- [@Priya](speaker:A) The sync wakes on a ninety-second retry loop.',
    '- [@Marcus](speaker:B) Decided: cap the backoff at ten minutes.',
    '- The team agreed to ship it Thursday.',
    '- Possibly related to the 0.4 rollout (unconfirmed).',
    '',
    '### Export range',
    '',
    '- The dialog forgets the range, which is a long-standing complaint that several people in the room repeated at some length again today.',
  ].join('\n');

  it('read topics and bullets out of a notes section', () => {
    expect(parseNotesTopics(notes).map((t) => t.heading)).toEqual([
      'Sync wakes too often',
      'Export range',
    ]);
    expect(allBullets(notes)).toHaveLength(5);
  });

  it('count a link by its label and a speaker tag not at all', () => {
    // The instructions promise the tag is free of the twenty-word budget, so
    // the judge that enforces the budget must not charge for it. Counting it
    // failed a nineteen-word bullet at 21 words on the first real eval run,
    // for carrying the attribution those same instructions demand.
    expect(bulletWords('[@Priya](speaker:A) The sync wakes on a ninety-second retry loop.')).toBe(
      8,
    );
    expect(bulletWords('The sync wakes on a ninety-second retry loop.')).toBe(8);
    // A citation still costs its title, and never its URL.
    expect(bulletWords('Fixed in [Retry loop wakes the sync](/workspaces/w-1?task=t-3).')).toBe(7);
  });

  it('find the bullet that ran past the bar and only that one', () => {
    const over = overlongBullets(notes);
    expect(over).toHaveLength(1);
    expect(over[0]?.bullet).toContain('long-standing complaint');
    expect(over[0]?.words).toBeGreaterThan(MAX_BULLET_WORDS);
  });

  it('find a decision written without the voice that made it', () => {
    const missing = decisionsWithoutSpeaker(notes);
    expect(missing).toEqual(['The team agreed to ship it Thursday.']);
  });

  it('see a second heading for a topic that already had one', () => {
    expect(duplicateTopics(notes)).toEqual([]);
    expect(duplicateTopics(`${notes}\n\n### export range!\n\n- More.`)).toEqual([
      'Sync wakes too often'.replace('Sync wakes too often', 'Export range'),
    ]);
  });

  it('see a row the notes name in prose without linking', () => {
    const board = [{ title: 'Export range', url: '/workspaces/w-1?task=t-7' }];
    expect(unlinkedReferences(notes, board)).toEqual(['Export range']);
    const linked = notes.replace(
      '### Export range',
      '### [Export range](/workspaces/w-1?task=t-7)',
    );
    expect(unlinkedReferences(linked, board)).toEqual([]);
  });

  it('count five flat bullets under one heading as a wall, and four as none', () => {
    const bullets = (n: number): string =>
      ['### Export range', '', ...Array.from({ length: n }, (_, i) => `- Point ${i + 1}.`)].join(
        '\n',
      );
    const five = longFlatRuns(bullets(5));
    expect(five).toHaveLength(1);
    expect(five[0]?.heading).toBe('Export range');
    expect(five[0]?.bullets).toHaveLength(5);
    expect(longFlatRuns(bullets(MAX_FLAT_RUN_BULLETS))).toEqual([]);
  });

  it('let a sub-bullet break the run, and drop its lead out of the count', () => {
    // Six bullets, one of them carrying a nested point: two runs of at most
    // three, so the topic reads as structure and nothing is reported. The
    // lead bullet leaves the run it introduces — counting it inside would
    // report the regrouped shape as the shape it replaced.
    const nested = [
      '### Export range',
      '',
      '- Point 1.',
      '- Point 2.',
      '- Point 3.',
      '  - The CSV path uses a different dialog.',
      '- Point 4.',
      '- Point 5.',
      '- Point 6.',
    ].join('\n');
    expect(longFlatRuns(nested)).toEqual([]);
    expect(flatBulletRuns(nested).map((r) => r.bullets.length)).toEqual([2, 3]);
  });

  it('let a subheading break the run', () => {
    const split = [
      '### Export range',
      '',
      '- Point 1.',
      '- Point 2.',
      '- Point 3.',
      '',
      '### Owner and timing',
      '',
      '- Point 4.',
      '- Point 5.',
      '- Point 6.',
    ].join('\n');
    expect(longFlatRuns(split)).toEqual([]);
    expect(flatBulletRuns(split).map((r) => r.heading)).toEqual([
      'Export range',
      'Owner and timing',
    ]);
  });

  it('count one wall per heading', () => {
    const two = [
      '### Export range',
      '',
      ...Array.from({ length: 5 }, (_, i) => `- Export point ${i + 1}.`),
      '',
      '### Sync wakes too often',
      '',
      ...Array.from({ length: 5 }, (_, i) => `- Sync point ${i + 1}.`),
    ].join('\n');
    expect(longFlatRuns(two).map((r) => r.heading)).toEqual([
      'Export range',
      'Sync wakes too often',
    ]);
  });

  it('count bullets written before any heading, which is the wall at its purest', () => {
    const headless = Array.from({ length: 5 }, (_, i) => `- Point ${i + 1}.`).join('\n');
    const runs = longFlatRuns(headless);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.heading).toBe('');
  });

  it('see a bullet that copied the transcript instead of paraphrasing it', () => {
    const transcript =
      'so the sync wakes on a ninety second retry loop and it has done that for weeks';
    const copied = '- so the sync wakes on a ninety second retry loop';
    expect(verbatimBullets(copied, transcript)).toHaveLength(1);
    expect(verbatimBullets('- The sync retries too eagerly.', transcript)).toEqual([]);
  });
});

/* ===== Attribution across the two-layer writing rule ===== */

/**
 * The nested note-takers write a point and its speaker on DIFFERENT LINES,
 * which is what the instructions ask of them. Read flat, every one of those
 * decisions looks unattributed — the failure that put `method:ledger-haiku`
 * at 8% on this bar against `method:original`'s 100% on the same meeting,
 * with the whole gap coming from format rather than from a missing voice.
 */
describe('a decision attributed one line down', () => {
  const nested = [
    '### Remote control design',
    '',
    '- The team agreed to ship the locator beep on Thursday',
    '  - [@Speaker D](speaker:D?t=4,6) proposed it and owns the prototype',
    '  - Cost of the beeper is not known yet (unconfirmed)',
  ].join('\n');

  it('reads the sub-bullets as belonging to the bullet above them', () => {
    const [lead] = nestedBullets(nested);
    expect(lead?.text).toBe('The team agreed to ship the locator beep on Thursday');
    expect(lead?.children.map((c) => c.text)).toEqual([
      '[@Speaker D](speaker:D?t=4,6) proposed it and owns the prototype',
      'Cost of the beeper is not known yet (unconfirmed)',
    ]);
  });

  it('counts a lead bullet as attributed when a sub-bullet names the speaker', () => {
    expect(decisionsWithoutSpeaker(nested)).toEqual([]);
  });

  it('still catches a decision no line under it attributes', () => {
    const orphan = nested
      .replace(
        '[@Speaker D](speaker:D?t=4,6) proposed it and owns the prototype',
        'Someone proposed it',
      )
      .replace('Cost of the beeper is not known yet (unconfirmed)', 'Cost is not known yet');
    expect(decisionsWithoutSpeaker(orphan)).toEqual([
      'The team agreed to ship the locator beep on Thursday',
    ]);
  });

  it('does not let a speaker under one bullet attribute the next one', () => {
    const two = [
      '- [@Speaker B](speaker:B?t=1) will write the brief',
      '- The team agreed to ship on Thursday',
    ].join('\n');
    expect(decisionsWithoutSpeaker(two)).toEqual(['The team agreed to ship on Thursday']);
  });

  it('starts the tree again at a heading, so a bullet cannot adopt one across it', () => {
    const across = [
      '- The team agreed to ship on Thursday',
      '',
      '### Next steps',
      '',
      '  - [@Speaker B](speaker:B?t=1) will write the brief',
    ].join('\n');
    expect(decisionsWithoutSpeaker(across)).toEqual(['The team agreed to ship on Thursday']);
  });

  it('reads a tab as an indent, because a model that tabs still wrote a sub-bullet', () => {
    const tabbed = [
      '- The team agreed to ship on Thursday',
      '\t- [@Speaker D](speaker:D?t=4) owns it',
    ].join('\n');
    expect(decisionsWithoutSpeaker(tabbed)).toEqual([]);
  });
});

describe('a heading with nothing under it', () => {
  const OPENED = ['### Battery life', '', '- [@B](speaker:B?t=4) wants a year'].join('\n');

  it('is reported, while a heading with bullets is not', () => {
    const notes = [
      '### Battery life',
      '',
      '- [@B](speaker:B?t=4) wants a year on a coin cell',
      '',
      '### Casing colour',
    ].join('\n');
    expect(emptyHeadings(notes)).toEqual(['Casing colour']);
  });

  it('CONTROL: notes with no heading at all report nothing', () => {
    // The bullets a note-taker writes before it opens any topic sit in a
    // heading-less pseudo-topic; reporting that as an empty heading would put
    // every flat run in the list.
    expect(emptyHeadings('- a bullet before any heading\n')).toEqual([]);
    expect(emptyHeadings('')).toEqual([]);
  });

  it('is reported whatever level it was written at', () => {
    expect(emptyHeadings('#### Battery life\n')).toEqual(['Battery life']);
  });

  it('is not reported for a heading whose only bullet is an indented one', () => {
    // The nested method writes a lead bullet and its propositions one layer
    // down; a tick that landed only the layer below still wrote under the
    // heading, and reading it as empty would strand a heading that has words
    // in it.
    expect(emptyHeadings('### Battery life\n\n  - on a coin cell\n')).toEqual([]);
  });

  it('counts as OPENED when this update is the one that wrote it', () => {
    expect(
      openedEmptyHeadings(
        '- a bullet before any heading\n',
        '- a bullet before any heading\n\n### Battery life\n',
      ),
    ).toEqual(['Battery life']);
  });

  it('is NOT opened by this update when it was already there and already empty', () => {
    // The distinction the whole fix turns on: frame one of a two-frame action
    // is the writer obeying, and a heading nobody ever came back for is not.
    expect(
      openedEmptyHeadings('### Battery life\n', '### Battery life\n\n### Casing colour\n'),
    ).toEqual(['Casing colour']);
  });

  it('is not opened by an update that filled the heading it found', () => {
    expect(openedEmptyHeadings('### Battery life\n', OPENED)).toEqual([]);
  });

  it('tells two headings apart when neither is written in Latin letters', () => {
    // Reduced to ASCII these two keys are both the empty string, and so is
    // the heading-less run of bullets above them — which read a heading the
    // notes had never carried as one they already had.
    const before = '- \u4e00\u6761\u8bb0\u5f55\n';
    expect(openedEmptyHeadings(before, `${before}\n### \u7535\u6c60\u5bff\u547d\n`)).toEqual([
      '\u7535\u6c60\u5bff\u547d',
    ]);
    expect(
      openedEmptyHeadings(
        '### \u7535\u6c60\u5bff\u547d\n',
        '### \u7535\u6c60\u5bff\u547d\n\n### \u5916\u58f3\u989c\u8272\n',
      ),
    ).toEqual(['\u5916\u58f3\u989c\u8272']);
  });

  it('a heading made only of punctuation is not a topic to wait for', () => {
    // A rule or a divider is not a subject the room raised, so there are no
    // bullets coming for it and nothing to wait a tick for.
    expect(openedEmptyHeadings('### Battery life\n', '### Battery life\n\n### ***\n')).toEqual([]);
  });

  it('reads a heading re-punctuated between the two updates as the same heading', () => {
    // "Export range" and "Export Range:" are one topic to a reader, and a
    // heading that looks new only because a colon arrived is not a new topic.
    expect(openedEmptyHeadings('### Battery Life:\n', '### Battery life\n')).toEqual([]);
  });
});
