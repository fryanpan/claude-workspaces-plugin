import { describe, expect, test } from 'bun:test';
import type { NotesTurn } from '../src/meeting-notes.ts';
import {
  MAX_CARRIED,
  MAX_CARRY_AGE,
  createNotesLedger,
  ledgerPrompt,
  ledgerTranscript,
  nestedNotesInstructions,
} from '../src/notes-ledger.ts';
import { DEFAULT_NOTES_INSTRUCTIONS } from '../src/notes-prompt-store.ts';

/** A fetch that answers one tool call with `points`, and records what it was
 *  asked. Nothing here reaches the network. */
function extractFetch(pointsPerCall: string[][]): {
  impl: typeof fetch;
  prompts: string[];
  calls: () => number;
} {
  const prompts: string[] = [];
  let n = 0;
  const impl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    prompts.push(body.messages[0]?.content ?? '');
    const points = pointsPerCall[n] ?? [];
    n++;
    return new Response(
      JSON.stringify({ content: [{ type: 'tool_use', name: 'record_points', input: { points } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { impl, prompts, calls: () => n };
}

const turn = (n: number, text: string, speaker?: string, label?: string): NotesTurn => ({
  turn: n,
  text,
  ...(speaker ? { speaker } : {}),
  ...(label ? { speakerLabel: label } : {}),
});

describe('the speech the extract is given', () => {
  test('every line names who said it and carries the engine label', () => {
    const text = ledgerTranscript([
      turn(1, 'the boardwalk needs a survey', 'Maya Okonkwo', 'A'),
      turn(2, 'the plaque wording is settled', 'Devin Aluko', 'B'),
    ]);
    expect(text).toBe(
      'Maya Okonkwo (A): the boardwalk needs a survey\nDevin Aluko (B): the plaque wording is settled',
    );
  });

  test('an unnamed voice still gets a name, so no line is speakerless', () => {
    expect(ledgerTranscript([turn(1, 'we should check the budget')])).toBe(
      'Speaker 1: we should check the budget',
    );
  });

  test('a turn still being spoken says so, so the extract does not read a fragment as finished', () => {
    const text = ledgerTranscript([
      { turn: 1, text: 'and the cost of the', speaker: 'Maya Okonkwo', partial: true },
    ]);
    expect(text).toContain('[still being spoken]');
  });
});

describe('the checklist handed to the writer', () => {
  test('no points is no checklist at all, so the tick composes as the original would', () => {
    expect(ledgerPrompt([])).toBe('');
  });

  test('the points arrive as a list', () => {
    const prompt = ledgerPrompt(['Maya (A): survey the boardwalk', 'Room: budget is capped']);
    expect(prompt).toContain('- Maya (A): survey the boardwalk');
    expect(prompt).toContain('- Room: budget is capped');
  });

  test('the checklist restates the speaker rule it competes with', () => {
    // THE REGRESSION THIS GUARDS. The exploration's ledger held the
    // "decisions and questions keep a speaker" bar at 22–42% where the
    // original holds it at 100%, because a writer working down an
    // unattributed list wrote unattributed notes. The rule has to be IN the
    // block that displaces it.
    const prompt = ledgerPrompt(['Maya (A): survey the boardwalk']);
    expect(prompt).toContain('EACH LINE BEGINS WITH WHO SAID IT');
    expect(prompt).toContain('ATTRIBUTION RULES ABOVE STILL GOVERN');
  });
});

describe('a tick with nothing said pays no round trip', () => {
  test('empty speech does not call the model', async () => {
    const f = extractFetch([['never asked for']]);
    const ledger = createNotesLedger({ apiKey: 'k-test', fetchImpl: f.impl });
    expect(await ledger.before([])).toBe('');
    expect(f.calls()).toBe(0);
  });

  test('CONTROL: speech does call it', async () => {
    const f = extractFetch([['Maya (A): survey the boardwalk']]);
    const ledger = createNotesLedger({ apiKey: 'k-test', fetchImpl: f.impl });
    expect(await ledger.before([turn(1, 'survey the boardwalk', 'Maya Okonkwo', 'A')])).toContain(
      'survey the boardwalk',
    );
    expect(f.calls()).toBe(1);
  });
});

describe('what the carry offers again', () => {
  test('a point the notes now carry is not offered a second time', async () => {
    const f = extractFetch([['Maya (A): survey the boardwalk'], []]);
    const ledger = createNotesLedger({ apiKey: 'k-test', fetchImpl: f.impl });
    await ledger.before([turn(1, 'survey the boardwalk', 'Maya Okonkwo', 'A')]);
    ledger.after('- Maya: the boardwalk section needs a survey before work starts');
    // Second tick: the extract answers nothing, so anything in the prompt
    // would have to be carried — and it was placed, so nothing is.
    expect(await ledger.before([turn(2, 'next topic', 'Devin Aluko', 'B')])).toBe('');
  });

  test('a point the notes did NOT carry rides to the next tick', async () => {
    const f = extractFetch([['Maya (A): survey the boardwalk'], []]);
    const ledger = createNotesLedger({ apiKey: 'k-test', fetchImpl: f.impl });
    await ledger.before([turn(1, 'survey the boardwalk', 'Maya Okonkwo', 'A')]);
    ledger.after('- Devin: the plaque wording is settled');
    expect(await ledger.before([turn(2, 'next topic', 'Devin Aluko', 'B')])).toContain(
      'survey the boardwalk',
    );
  });

  test('a point declined often enough stops being offered', async () => {
    const f = extractFetch([['Maya (A): survey the boardwalk'], [], [], [], []]);
    const ledger = createNotesLedger({ apiKey: 'k-test', fetchImpl: f.impl });
    await ledger.before([turn(1, 'survey the boardwalk', 'Maya Okonkwo', 'A')]);
    let offers = 0;
    for (let i = 0; i < 4; i++) {
      ledger.after('- Devin: something else entirely');
      if ((await ledger.before([turn(i + 2, 'more talk', 'Devin Aluko', 'B')])).length > 0)
        offers++;
    }
    // Offered while its age is under the ceiling, and then dropped: a point
    // the writer has declined that many times with the notes in front of it
    // is being declined on purpose.
    expect(offers).toBe(MAX_CARRY_AGE);
  });

  test('the carry has a ceiling, and it keeps the newest points', async () => {
    const many = Array.from({ length: MAX_CARRIED + 8 }, (_, i) => `Maya (A): point number ${i}`);
    const f = extractFetch([many, []]);
    const ledger = createNotesLedger({ apiKey: 'k-test', fetchImpl: f.impl });
    await ledger.before([turn(1, 'a long stretch of talk', 'Maya Okonkwo', 'A')]);
    ledger.after('- nothing of the sort was written');
    const second = await ledger.before([turn(2, 'more', 'Devin Aluko', 'B')]);
    const offered = second.split('\n').filter((l) => l.startsWith('- Maya (A): point number'));
    expect(offered).toHaveLength(MAX_CARRIED);
    // The newest survive: the points just raised are the ones still live.
    expect(offered.at(-1)).toContain(`point number ${MAX_CARRIED + 7}`);
  });
});

describe('an extract that cannot be read degrades to the original note-taker', () => {
  async function ledgerAnswering(res: () => Promise<Response>): Promise<string> {
    const errors: string[] = [];
    const ledger = createNotesLedger({
      apiKey: 'k-test',
      fetchImpl: res as unknown as typeof fetch,
      onError: (m) => errors.push(m),
    });
    const out = await ledger.before([turn(1, 'survey the boardwalk', 'Maya Okonkwo', 'A')]);
    expect(errors.length).toBeGreaterThan(0);
    return out;
  }

  test('an HTTP error is an empty checklist, not a thrown tick', async () => {
    expect(await ledgerAnswering(async () => new Response('nope', { status: 500 }))).toBe('');
  });

  test('a network failure is an empty checklist, not a thrown tick', async () => {
    expect(
      await ledgerAnswering(async () => {
        throw new Error('socket hang up');
      }),
    ).toBe('');
  });

  test('a body that is not JSON is an empty checklist', async () => {
    expect(
      await ledgerAnswering(async () => new Response('<html>gateway</html>', { status: 200 })),
    ).toBe('');
  });

  test('a reply with no tool call is an empty checklist', async () => {
    const ledger = createNotesLedger({
      apiKey: 'k-test',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ content: [{ type: 'text' }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    expect(await ledger.before([turn(1, 'talk', 'Maya Okonkwo', 'A')])).toBe('');
  });
});

describe('the extract never sends the meeting anywhere but the model', () => {
  test('the error line carries a status, never the speech', async () => {
    const errors: string[] = [];
    const ledger = createNotesLedger({
      apiKey: 'k-test',
      fetchImpl: (async () =>
        new Response('the boardwalk section still needs a survey', {
          status: 502,
        })) as unknown as typeof fetch,
      onError: (m) => errors.push(m),
    });
    await ledger.before([turn(1, 'the boardwalk section still needs a survey', 'Maya Okonkwo')]);
    expect(errors.join('\n')).not.toContain('boardwalk');
    expect(errors.join('\n')).toContain('502');
  });
});

describe('the nested rule keeps the speaker where the flat one had it', () => {
  // The measured regression this closes: nested notes scored 73% on
  // "decisions and questions keep a speaker" against the original's 100%,
  // because the rule's own worked example wrote a bare "B:" and its lead
  // bullets had a twelve-word ceiling to fit under.
  const nested = nestedNotesInstructions(DEFAULT_NOTES_INSTRUCTIONS);

  test('its worked example writes a real speaker tag, not a bare label', () => {
    expect(nested).toContain('](speaker:B)');
  });

  test('a lead bullet is told the tag does not count towards its twelve', () => {
    expect(nested).toContain("nor towards a lead bullet's twelve");
  });

  test('MUTATION CONTROL: the instructions it replaced said neither', () => {
    // Same source, no swap. If these passed either way the two above would
    // be reading the shipped prompt rather than the rule this module adds.
    expect(DEFAULT_NOTES_INSTRUCTIONS).not.toContain('](speaker:B)');
    expect(DEFAULT_NOTES_INSTRUCTIONS).not.toContain("nor towards a lead bullet's twelve");
  });
});
