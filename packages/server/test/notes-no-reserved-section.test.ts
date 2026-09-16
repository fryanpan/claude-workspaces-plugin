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
