/**
 * There is no reserved section any more.
 *
 * THE PREMISE THIS REPRODUCES: a meeting used to open `## Meeting notes` and
 * write everything it heard inside it — a container beside the document's own
 * structure, with the doc's real topics left outside it. The owner's rule
 * (2026-09-15) is the other way round: notes land under the topic they belong
 * to, and a doc with nowhere to put them gets a TOPIC heading, not a
 * container.
 *
 * So nothing here asserts a heading is absent by name alone. Each case drives
 * the surface that used to write the container and asks what it writes now.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { buildNotesPrompt } from '../src/notes-prompt-build.ts';
import { input } from './notes-compose-input.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

/** The same tick, with no section of this meeting's in the doc. */
function homeless(outline: NotesComposeInput['outline']): NotesComposeInput {
  const { notesHeadingId: _drop, ...rest } = input;
  return { ...rest, outline };
}

describe('a meeting opens a topic, not a container', () => {
  it('asks an empty doc for a topic heading and names no reserved section', () => {
    const prompt = buildNotesPrompt(homeless([]));
    expect(prompt.user).not.toContain('Meeting notes');
    expect(prompt.user).toContain('## ');
    expect(prompt.user.toLowerCase()).toContain('topic');
  });

  it('asks a doc written at level three for a level-three topic', () => {
    const prompt = buildNotesPrompt(
      homeless([
        { id: 'h1', kind: 'heading', nodeName: 'heading', level: 3, text: 'Roadmap' },
        { id: 'h2', kind: 'heading', nodeName: 'heading', level: 3, text: 'Hiring' },
      ]),
    );
    expect(prompt.user).toContain('### ');
    expect(prompt.user).not.toContain('## Meeting notes');
  });

  it('starts its own topic on a doc whose notes heading is somebody else’s', async () => {
    const harness = createNotesTickHarness({
      doc: '# Q3 planning\n\n## Meeting notes\n\n- last week: the sync is slow\n\n## Roadmap\n\nA line.\n',
      compose: (composeInput) => addNotes(composeInput, '- the cache is the fix', 'Caching'),
    });
    await harness.speak('The cache is the fix.');
    await harness.end();
    // One `Meeting notes` heading, and it is the one that was already there:
    // nothing opened a twin, and nothing wrote into a section this meeting
    // never claimed.
    expect(harness.countHeadings('Meeting notes')).toBe(1);
    expect(harness.headings()).toContain('Caching');
    const md = harness.markdown();
    expect(md.indexOf('the cache is the fix')).toBeGreaterThan(md.indexOf('## Caching'));
    expect(md).toContain('- last week: the sync is slow');
  });
});

/**
 * A MEETING THAT NEVER OPENS A HEADING OF ITS OWN.
 *
 * The doc already has the topic the room is on, so the note-taker writes under
 * it and opens nothing. That meeting holds NO CLAIM — and two protections used
 * to be scoped to the claimed section, so a meeting without one lost both for
 * its whole length: the duplicate check had an empty set to compare against,
 * and the rule that turns an erasing rewrite into an extra note had nowhere to
 * put the note, so the rewrite went straight through. Raised by the
 * independent review; both drive the real tick path here.
 */
describe('a meeting that writes only under headings the doc already had', () => {
  const DOC = '# Harbour plan\n\n## Pricing\n\n- the tiers are drafted\n';
  /** Insert under the first heading the doc came with, never opening one. */
  const underTheirs = (i: NotesComposeInput, markdown: string) => {
    const theirs = i.outline.find((e) => e.kind === 'heading' && e.text.trim() === 'Pricing');
    return theirs === undefined
      ? []
      : [{ op: 'insert_under_heading' as const, headingId: theirs.id, markdown }];
  };

  it('still drops a note the doc already carries', async () => {
    const harness = createNotesTickHarness({
      doc: DOC,
      compose: (i) => underTheirs(i, '- support hours split out of the top tier'),
    });
    await harness.speak('support hours come out of the top tier');
    await harness.speak('so support hours come out of the top tier');
    await harness.end();
    // The meeting opened nothing, so it holds no claim…
    expect(harness.headings()).toEqual(['Harbour plan', 'Pricing']);
    // …and the note it composed twice is in the doc once.
    const md = harness.markdown();
    expect(md.split('support hours split out of the top tier')).toHaveLength(2);
  });

  it('still turns a rewrite that would erase an idea into a second note', async () => {
    const harness = createNotesTickHarness({
      doc: DOC,
      compose: (i, tick) => {
        if (tick === 1) return underTheirs(i, '- support hours split out of the top tier');
        const mine = i.outline.find(
          (e) => e.kind === 'listItem' && e.text.includes('support hours'),
        );
        return mine === undefined
          ? []
          : // Words the bullet never said: a rewrite here LOSES the first idea.
            [
              {
                op: 'replace_block' as const,
                blockId: mine.id,
                markdown: '- onboarding moves too',
              },
            ];
      },
    });
    await harness.speak('support hours come out of the top tier');
    await harness.speak('and onboarding moves with it');
    await harness.end();
    const md = harness.markdown();
    expect(md).toContain('support hours split out of the top tier');
    expect(md).toContain('onboarding moves too');
    expect(harness.headings()).toEqual(['Harbour plan', 'Pricing']);
  });
});
