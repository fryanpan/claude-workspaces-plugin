/**
 * The real notes composer: prompt shape, reply reading, and the HTTP seam —
 * all through a stubbed fetch, because a test that reached api.anthropic.com
 * would spend real money to assert string handling.
 *
 * WHAT CHANGED. The composer used to be handed the notes as prose and to
 * answer with prose; it is now handed an OUTLINE of blocks with ids and
 * answers with a JSON array of edits. So the prompt assertions are about what
 * the outline renders as, and the reply assertions are about edits rather than
 * about a sanitized markdown string.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  NOTES_MODEL,
  buildNotesPrompt,
  createHaikuNotesComposer,
  readNotesEdits,
} from '../src/meeting-notes-composer.ts';
import type { NotesComposeInput } from '../src/meeting-notes.ts';

/** One edit, as a model would answer with it. */
const ONE_EDIT = '[{"op":"insert_under_heading","headingId":"h1","markdown":"- the sync is slow"}]';

const input: NotesComposeInput = {
  docId: 'doc-a',
  meetingId: 'm-doc-a-1',
  tick: {
    tick: 2,
    reason: 'pause',
    turns: [
      { turn: 3, text: 'The sync is the bottleneck.' },
      { turn: 4, text: 'Measure before rewriting.' },
    ],
  },
  outline: [
    {
      id: 'h1',
      kind: 'heading',
      nodeName: 'heading',
      level: 2,
      text: 'Meeting notes',
      author: 'meeting-notes',
    },
    {
      id: 'b1',
      kind: 'listItem',
      nodeName: 'listItem',
      text: 'earlier point',
      author: 'meeting-notes',
      underHeadingId: 'h1',
    },
  ],
  notesHeadingId: 'h1',
  context: {
    docTitle: 'Q3 planning',
    taskTitles: ['Bryan can hear his meeting become notes'],
    repoRoot: '/repo/planning',
  },
};

/** A fetch stub that records the request and answers with `body`. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe('notes prompt', () => {
  it('carries the delta, the doc as addressable blocks, and the project context', () => {
    const { system, user } = buildNotesPrompt(input);
    expect(system).toContain('insert_under_heading');
    for (const turn of input.tick.turns) expect(user).toContain(turn.text);
    // The block table, not the notes as prose: an id, its kind, whose it is.
    expect(user).toContain('b1 bullet yours under=h1 | earlier point');
    expect(user).toContain('h1 h2 yours | Meeting notes');
    expect(user).toContain('Q3 planning');
    expect(user).toContain('Bryan can hear his meeting become notes');
    expect(user).toContain('/repo/planning');
  });

  it('names which heading is this meeting’s, so a bullet has an id to go under', () => {
    const { user } = buildNotesPrompt(input);
    expect(user).toContain('notes are under heading h1.');
  });

  it('a block a person has touched reads as theirs, which is what gates a rewrite', () => {
    // `author` is cleared by the doc the moment a person edits a block, so
    // "theirs" is the whole signal the model gets that a rewrite would land
    // as a suggestion. If this line ever rendered "yours" the model would be
    // told it may freely overwrite a person's words.
    const { user } = buildNotesPrompt({
      ...input,
      outline: [{ id: 'b9', kind: 'listItem', nodeName: 'listItem', text: 'my own line' }],
    });
    expect(user).toContain('b9 bullet theirs | my own line');
    expect(user).not.toContain('b9 bullet yours');
  });

  it('asks for a section to be opened when the meeting has none', () => {
    const { user } = buildNotesPrompt({
      ...input,
      outline: [{ id: 'p1', kind: 'block', nodeName: 'paragraph', text: 'agenda' }],
      notesHeadingId: undefined,
    });
    expect(user).toContain('NO notes section');
    expect(user).toContain('## Meeting notes');
  });

  it('an empty doc says so rather than rendering an empty table', () => {
    const { user } = buildNotesPrompt({
      ...input,
      outline: [],
      notesHeadingId: undefined,
      context: undefined,
    });
    expect(user).toContain('The doc is empty');
    expect(user).not.toContain('Project context');
  });

  it('names the speaker on each line when the tick knows one', () => {
    const { system, user } = buildNotesPrompt({
      ...input,
      tick: {
        ...input.tick,
        turns: [
          { turn: 3, text: 'Can you take the migration?', speaker: 'Jordan' },
          { turn: 4, text: 'Sure.', speaker: 'Speaker B' },
          { turn: 5, text: 'Thanks.' },
        ],
      },
    });
    expect(user).toContain('- Jordan: Can you take the migration?');
    expect(user).toContain('- Speaker B: Sure.');
    expect(user).toContain('- Thanks.');
    expect(system).toContain('Speaker B');
  });

  it('carries the LABEL beside the name, and asks for the tag that uses it', () => {
    // The name is what a reader recognises; the label is what a rename can
    // find again. The prompt has to hand over both or the tag it asks for
    // cannot be written.
    const { system, user } = buildNotesPrompt({
      ...input,
      tick: {
        ...input.tick,
        turns: [
          { turn: 3, text: 'Move the gate.', speaker: 'Devi', speakerLabel: 'B' },
          { turn: 4, text: 'Agreed.', speaker: 'Speaker A', speakerLabel: 'A' },
          { turn: 5, text: 'Unattributed.' },
        ],
      },
    });
    expect(user).toContain('- Devi (B): Move the gate.');
    expect(user).toContain('- Speaker A (A): Agreed.');
    expect(user).toContain('- Unattributed.');
    expect(system).toContain('[@Name](speaker:LABEL)');
  });

  it('tells the model a block that is not its own is edited only as a correction', () => {
    const { system } = buildNotesPrompt(input);
    expect(system).toContain('ONLY EDIT A BLOCK MARKED "yours"');
    expect(system).toContain('suggestion');
  });
});

describe('readNotesEdits', () => {
  it('reads a bare array of edits', () => {
    expect(readNotesEdits(ONE_EDIT)).toEqual([
      { op: 'insert_under_heading', headingId: 'h1', markdown: '- the sync is slow' },
    ]);
  });

  it('unwraps a fenced reply, because models fence JSON too', () => {
    expect(readNotesEdits(`\`\`\`json\n${ONE_EDIT}\n\`\`\``)).toHaveLength(1);
  });

  it('keeps the good edits and drops the malformed one', () => {
    const edits = readNotesEdits(
      `[{"op":"insert_at_end","markdown":"## Risks"},{"op":"teleport","blockId":"b1"}]`,
    );
    expect(edits).toEqual([{ op: 'insert_at_end', markdown: '## Risks' }]);
  });

  it('a reply that yields no edit throws, so the tick carries its words forward', () => {
    // Prose is the failure this contract exists to catch: the old composer
    // would have taken it as the notes.
    expect(() => readNotesEdits('## Meeting notes\n- a point')).toThrow('no usable edits');
    expect(() => readNotesEdits('[]')).toThrow('no usable edits');
  });
});

describe('createHaikuNotesComposer', () => {
  it('no key means no composer — the documented off state, not an error', () => {
    expect(createHaikuNotesComposer({ apiKey: null })).toBeNull();
  });

  it('posts the prompt to the API with the dedicated key and returns the edits', async () => {
    const { impl, calls } = stubFetch({
      content: [{ text: ONE_EDIT }],
      stop_reason: 'end_turn',
    });
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    expect(composer).not.toBeNull();
    const edits = await composer?.compose(input);
    expect(edits).toEqual([
      { op: 'insert_under_heading', headingId: 'h1', markdown: '- the sync is slow' },
    ]);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k-test');
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    expect(body.model).toBe(NOTES_MODEL);
    expect(body.messages[0]?.content).toContain('Measure before rewriting.');
  });

  it('an HTTP failure rejects, so the session carries the words forward', async () => {
    const { impl } = stubFetch({ error: 'overloaded' }, 529);
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    expect(composer?.compose(input)).rejects.toThrow('529');
  });

  it('a reply cut at the token ceiling rejects rather than applying half a batch', async () => {
    const { impl } = stubFetch({
      content: [{ text: '[{"op":"insert_at_end","markdown":"## cut' }],
      stop_reason: 'max_tokens',
    });
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    expect(composer?.compose(input)).rejects.toThrow('max_tokens');
  });

  it('an empty reply rejects — a tick that wrote nothing must not read as covered', async () => {
    const { impl } = stubFetch({ content: [{ text: '   ' }], stop_reason: 'end_turn' });
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    expect(composer?.compose(input)).rejects.toThrow('empty');
  });
});

describe('captured task links in the prompt', () => {
  it('offers each link and the instruction to cite it', () => {
    const { user } = buildNotesPrompt({
      ...input,
      taskLinks: [
        { title: 'Strip overlaps navbar', url: '/workspaces/w-b?task=t-9', status: 'todo' },
      ],
    });
    expect(user).toContain('[Strip overlaps navbar](/workspaces/w-b?task=t-9)');
    expect(user).toContain('todo');
    expect(user.toLowerCase()).toContain('markdown link');
  });

  it('says nothing about tasks when the tick captured none', () => {
    const { user } = buildNotesPrompt(input);
    expect(user.toLowerCase()).not.toContain('markdown link');
  });
});

describe('material pulled in, in the prompt', () => {
  it('offers each doc link, its when, and the rule against summarizing it', () => {
    const { user } = buildNotesPrompt({
      ...input,
      docLinks: [
        { title: 'Offline queue notes', url: '/workspaces/w-b/docs/d-q', when: 'last week' },
        { title: 'Team charter', url: '/workspaces/w-b/docs/d-c' },
      ],
    });
    expect(user).toContain('[Offline queue notes](/workspaces/w-b/docs/d-q) — last week');
    // A doc with no meeting behind it gets no when, and no dangling dash.
    expect(user).toContain('[Team charter](/workspaces/w-b/docs/d-c)\n');
    expect(user).not.toContain('[Team charter](/workspaces/w-b/docs/d-c) —');
    // It has not read them, so it may not say what is in them.
    expect(user).toContain('Do not summarize what is inside');
  });

  it('says nothing about material when the tick asked for none', () => {
    const { user } = buildNotesPrompt(input);
    expect(user).not.toContain('asked to have pulled in');
  });
});
