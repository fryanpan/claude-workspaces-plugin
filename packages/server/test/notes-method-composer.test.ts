import { describe, expect, test } from 'bun:test';
import { NOTES_METHODS, type NotesMethod } from '@claude-workspaces/core';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { LEDGER_FLAT_RUN_ANCHOR } from '../src/notes-ledger.ts';
import { createNotesMethodComposer } from '../src/notes-method-composer.ts';

/** What one call to the model was: which model, and the prompt it carried. */
interface Seen {
  model: string;
  system: string;
  user: string;
  tool?: string;
  /** How much of the ceiling a thinking model may think for, as sent. */
  effort?: string;
}

/**
 * One fetch standing in for BOTH calls the ledger path makes — the extract
 * and the compose — told apart by the tool the request asks for. The compose
 * answers an empty edit list, which is a legitimate answer and keeps the test
 * about dispatch rather than about parsing.
 */
function harness(points: string[] = ['Maya (A): survey the boardwalk']): {
  impl: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      system: string;
      tools?: Array<{ name: string }>;
      messages: Array<{ content: string }>;
      output_config?: { effort?: string };
    };
    const tool = body.tools?.[0]?.name;
    seen.push({
      model: body.model,
      system: body.system,
      user: body.messages[0]?.content ?? '',
      ...(tool ? { tool } : {}),
      ...(body.output_config?.effort ? { effort: body.output_config.effort } : {}),
    });
    if (tool === 'record_points') {
      return new Response(
        JSON.stringify({
          content: [{ type: 'tool_use', name: 'record_points', input: { points } }],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '[]' }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const input = (docId = 'd1'): NotesComposeInput => ({
  docId,
  meetingId: 'm-1',
  tick: {
    tick: 1,
    reason: 'pause',
    turns: [{ turn: 1, text: 'the boardwalk needs a survey', speaker: 'Maya Okonkwo' }],
  },
  outline: [],
});

function composerFor(method: NotesMethod | ((docId: string) => NotesMethod), h = harness()) {
  const composer = createNotesMethodComposer({
    methodFor: typeof method === 'function' ? method : () => method,
    apiKey: 'k-test',
    composerOpts: { apiKey: 'k-test', fetchImpl: h.impl },
    ledgerFetch: h.impl,
  });
  if (!composer) throw new Error('no composer built');
  return { composer, seen: h.seen };
}

/** The calls that were the note-taker writing, not the ledger enumerating. */
const composes = (seen: Seen[]): Seen[] => seen.filter((s) => s.tool !== 'record_points');
const extracts = (seen: Seen[]): Seen[] => seen.filter((s) => s.tool === 'record_points');

describe('the key the server never passed, resolved where both halves read it', () => {
  /**
   * The production shape, which every other test in this file skips past:
   * `server-deps.ts` names no key at all, because the compose half has always
   * resolved its own from the Keychain. The extract half cannot, so unless
   * one resolution is handed to both, a ledger method runs its two-layer
   * prompt with no checklist behind it and is a one-pass note-taker wearing
   * the ledger's name.
   */
  function asTheServerBuildsIt(readKey: () => string | null) {
    const seen: Array<{ tool?: string; key: string }> = [];
    const impl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tools?: Array<{ name: string }> };
      const tool = body.tools?.[0]?.name;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ ...(tool ? { tool } : {}), key: headers['x-api-key'] ?? '' });
      if (tool === 'record_points') {
        return new Response(
          JSON.stringify({
            content: [
              { type: 'tool_use', name: 'record_points', input: { points: ['Maya (A): survey'] } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '[]' }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    // No `apiKey` on the deps and none on `composerOpts` — exactly what the
    // composition root passes.
    const composer = createNotesMethodComposer({
      methodFor: () => 'ledger-haiku',
      composerOpts: { fetchImpl: impl },
      ledgerFetch: impl,
      readKey,
    });
    return { composer, seen };
  }

  test('a ledger method still runs its extract, on the key the Keychain holds', async () => {
    const { composer, seen } = asTheServerBuildsIt(() => 'k-keychain');
    if (!composer) throw new Error('no composer built');
    await composer.compose(input());
    const extract = seen.filter((c) => c.tool === 'record_points');
    expect(extract).toHaveLength(1);
    expect(extract[0]?.key).toBe('k-keychain');
  });

  test('the compose half is on that same key, not a second read', async () => {
    const { composer, seen } = asTheServerBuildsIt(() => 'k-keychain');
    if (!composer) throw new Error('no composer built');
    await composer.compose(input());
    expect(seen.filter((c) => c.tool !== 'record_points')[0]?.key).toBe('k-keychain');
  });

  test('MUTATION CONTROL: no key anywhere and there is no composer at all', () => {
    const { composer } = asTheServerBuildsIt(() => null);
    expect(composer).toBeNull();
  });
});

describe('the original runs no extract', () => {
  test('one call, and it is the compose', async () => {
    const { composer, seen } = composerFor('original');
    await composer.compose(input());
    expect(extracts(seen)).toHaveLength(0);
    expect(composes(seen)).toHaveLength(1);
  });

  test('it composes on Haiku', async () => {
    const { composer, seen } = composerFor('original');
    await composer.compose(input());
    expect(composes(seen)[0]?.model).toContain('haiku');
  });

  test('the compose carries no checklist', async () => {
    const { composer, seen } = composerFor('original');
    await composer.compose(input());
    expect(composes(seen)[0]?.user).not.toContain('A FIRST PASS ALREADY READ');
  });
});

describe('a ledger method extracts first, then composes against the list', () => {
  test.each([['ledger-haiku'], ['ledger-opus']] as const)(
    '%s runs both calls, extract before compose',
    async (method) => {
      const { composer, seen } = composerFor(method);
      await composer.compose(input());
      expect(extracts(seen)).toHaveLength(1);
      expect(composes(seen)).toHaveLength(1);
      // ON THE CRITICAL PATH: the extract is call one, so this tick composes
      // against THIS tick's points rather than the previous tick's.
      expect(seen[0]?.tool).toBe('record_points');
    },
  );

  test('the extracted points reach the compose prompt', async () => {
    const { composer, seen } = composerFor('ledger-haiku');
    await composer.compose(input());
    expect(composes(seen)[0]?.user).toContain('Maya (A): survey the boardwalk');
  });

  test('the extract runs on Haiku even when Opus composes', async () => {
    const { composer, seen } = composerFor('ledger-opus');
    await composer.compose(input());
    // A ledger that paid the big model for its own bookkeeping would be a
    // bigger bill rather than a better note-taker.
    expect(extracts(seen)[0]?.model).toContain('haiku');
  });
});

describe('which model writes the notes', () => {
  test('ledger-haiku writes on Haiku', async () => {
    const { composer, seen } = composerFor('ledger-haiku');
    await composer.compose(input());
    expect(composes(seen)[0]?.model).toContain('haiku');
  });

  test('ledger-opus writes on Opus', async () => {
    const { composer, seen } = composerFor('ledger-opus');
    await composer.compose(input());
    expect(composes(seen)[0]?.model).toBe('claude-opus-5');
  });

  test('Opus thinks at the effort the exploration priced it at', async () => {
    // Every Opus figure in the shipping table — lost ideas AND dollars per
    // meeting-hour — was measured at effort low. Left off, the shipped
    // method is a more expensive note-taker than the one the table is about.
    const { composer, seen } = composerFor('ledger-opus');
    await composer.compose(input());
    expect(composes(seen)[0]?.effort).toBe('low');
  });

  test('MUTATION CONTROL: the Haiku methods send no effort at all', async () => {
    for (const method of ['original', 'ledger-haiku'] as const) {
      const { composer, seen } = composerFor(method);
      await composer.compose(input());
      expect(composes(seen)[0]?.effort).toBeUndefined();
    }
  });
});

describe('the method is read per tick, not per session', () => {
  test('a change between ticks changes what the next tick does', async () => {
    let method: NotesMethod = 'original';
    const { composer, seen } = composerFor(() => method);
    await composer.compose(input());
    method = 'ledger-opus';
    await composer.compose(input());
    // The first tick is one call on Haiku; the second is an extract plus a
    // compose on Opus. Nothing was rewired in between.
    expect(extracts(seen)).toHaveLength(1);
    expect(composes(seen).map((c) => c.model)).toEqual([
      expect.stringContaining('haiku'),
      'claude-opus-5',
    ]);
  });

  test('switching back to the original stops the extract', async () => {
    let method: NotesMethod = 'ledger-opus';
    const { composer, seen } = composerFor(() => method);
    await composer.compose(input());
    method = 'original';
    await composer.compose(input());
    expect(extracts(seen)).toHaveLength(1);
  });
});

describe('the doc decides, not the meeting', () => {
  test('two docs composing on one composer get their own methods', async () => {
    const { composer, seen } = composerFor((docId) =>
      docId === 'd-ledger' ? 'ledger-opus' : 'original',
    );
    await composer.compose(input('d-plain'));
    await composer.compose(input('d-ledger'));
    expect(extracts(seen)).toHaveLength(1);
    expect(composes(seen).map((c) => c.model)).toEqual([
      expect.stringContaining('haiku'),
      'claude-opus-5',
    ]);
  });
});

describe('an unreadable preference is the default, not a failed tick', () => {
  test('a store that throws still composes, on the original', async () => {
    const errors: string[] = [];
    const h = harness();
    const composer = createNotesMethodComposer({
      methodFor: () => {
        throw new Error('preference file is a directory');
      },
      apiKey: 'k-test',
      composerOpts: { apiKey: 'k-test', fetchImpl: h.impl },
      ledgerFetch: h.impl,
      onError: (m) => errors.push(m),
    });
    if (!composer) throw new Error('no composer built');
    await expect(composer.compose(input())).resolves.toEqual([]);
    expect(composes(h.seen)).toHaveLength(1);
    expect(extracts(h.seen)).toHaveLength(0);
    expect(errors.join('\n')).toContain('notes method unreadable');
  });
});

describe('no key is the whole feature off, as it always was', () => {
  test('null, so the caller keeps its "notes stay off" path', () => {
    expect(
      createNotesMethodComposer({
        methodFor: () => 'original',
        composerOpts: { apiKey: null },
      }),
    ).toBeNull();
  });
});

describe('a ledger with no key composes as the original', () => {
  test('the extract is skipped rather than called without a key', async () => {
    const h = harness();
    const composer = createNotesMethodComposer({
      methodFor: () => 'ledger-opus',
      // The compose has a key of its own; the ledger is given none.
      apiKey: null,
      composerOpts: { apiKey: 'k-test', fetchImpl: h.impl },
      ledgerFetch: h.impl,
    });
    if (!composer) throw new Error('no composer built');
    await composer.compose(input());
    expect(extracts(h.seen)).toHaveLength(0);
    // Still the method's model: it is the ledger that could not run, not the
    // choice that was ignored.
    expect(composes(h.seen)[0]?.model).toBe('claude-opus-5');
  });
});

describe('an extract that returns nothing composes exactly as the original would', () => {
  test('no points is no checklist in the prompt', async () => {
    const { composer, seen } = composerFor('ledger-haiku', harness([]));
    await composer.compose(input());
    expect(composes(seen)[0]?.user).not.toContain('A FIRST PASS ALREADY READ');
  });
});

describe('a ledger method writes in two layers, and the original does not', () => {
  // The pairing the exploration measured: the checklist is only worth its
  // call if every point on it has somewhere to go, and the nested rule is
  // what gives it one. Keyed by model alone the two cheap methods would share
  // a composer and `ledger-haiku` would silently run as the original — this
  // is the assertion that says they do not.

  const SHIPPED = [
    'Write the meeting notes.',
    LEDGER_FLAT_RUN_ANCHOR,
    'Keep the speaker on decisions and questions.',
  ].join('\n\n');

  async function composeWith(
    method: NotesMethod,
    instructions: string,
    onError?: (message: string) => void,
  ): Promise<string> {
    const h = harness();
    const composer = createNotesMethodComposer({
      methodFor: () => method,
      apiKey: 'k-test',
      composerOpts: { apiKey: 'k-test', fetchImpl: h.impl, instructions: () => instructions },
      ledgerFetch: h.impl,
      ...(onError ? { onError } : {}),
    });
    if (!composer) throw new Error('no composer built');
    await composer.compose(input());
    return composes(h.seen)[0]?.system ?? '';
  }

  test('the ledger methods compose against the nested rule', async () => {
    for (const method of ['ledger-haiku', 'ledger-opus'] as const) {
      const system = await composeWith(method, SHIPPED);
      expect(system).toContain('TWO LAYERS, ALWAYS');
      expect(system).not.toContain(LEDGER_FLAT_RUN_ANCHOR);
      // Everything else the person wrote is still theirs.
      expect(system).toContain('Keep the speaker on decisions and questions.');
    }
  });

  test('MUTATION CONTROL: the original composes against the shipped rule', async () => {
    const system = await composeWith('original', SHIPPED);
    expect(system).toContain(LEDGER_FLAT_RUN_ANCHOR);
    expect(system).not.toContain('TWO LAYERS, ALWAYS');
  });

  test('instructions the rule has been edited out of still compose, and say so', async () => {
    // A person retuning the prompt on the settings page must not be able to
    // turn a ledger method into a failed tick.
    let said = '';
    const system = await composeWith('ledger-haiku', 'Write the meeting notes.', () => {
      said = 'reported';
    });
    expect(system).toBe('Write the meeting notes.');
    expect(said).toBe('reported');
  });
});

/**
 * THE MEASURED INVENTION THIS CLOSES. On AMI ES2002b tick 14 the room was
 * untangling cables to plug in a laptop, and B's fragments assembled to
 * "it'd be a nice knot if everything now was wireless wouldn't it". All
 * three shipped methods turned that into a claim about the product:
 * `original` wrote "Wireless control should be considered for the remote
 * design", `ledger-haiku` wrote "proposes wireless design" and linked it to
 * the remote-control board row, and `ledger-opus` added "the remote itself
 * would be wireless anyway" on the following tick. So the rule that refuses
 * the upgrade has to reach EVERY method, and the ledger methods reach the
 * model through a prompt swap that rewrites a whole block — which is exactly
 * where a rule can be eaten without anything failing.
 */
describe('every shipped method is told not to write a point stronger than the speech', () => {
  const STRENGTH_RULE = 'NEVER WRITE A POINT STRONGER THAN THE SPEECH MADE IT';

  test('it reaches the compose on all three methods, the block-swapping ones included', async () => {
    for (const method of NOTES_METHODS) {
      const h = harness();
      const { composer } = composerFor(method, h);
      await composer.compose(input());
      const system = composes(h.seen)[0]?.system ?? '';
      expect(system).toContain(STRENGTH_RULE);
      // The three upgrades it names, each one a move measured in the corpus.
      expect(system).toContain('a remark about THE ROOM');
      expect(system).toContain('is not a commitment');
    }
  });

  test('the ledger extract carries the same bar, because it decides what a point IS', async () => {
    // "D: Committed to current approach" came back from this pass, out of D
    // saying "I'm all in [a knot]". The writer can only write what it is
    // handed, so the bar that stops the upgrade has to sit on both passes.
    const h = harness();
    const { composer } = composerFor('ledger-opus', h);
    await composer.compose(input());
    const extract = extracts(h.seen);
    expect(extract).toHaveLength(1);
    expect(extract[0]?.system).toContain('WRITE EACH POINT AT THE STRENGTH IT WAS SAID');
    expect(extract[0]?.system).toContain('is not a commitment');
  });

  test('MUTATION CONTROL: instructions without the rule reach the model without it', async () => {
    // The same wire, the same reader. If this passed too, the two above would
    // be asserting that a string exists somewhere rather than that it is what
    // the note-taker was actually sent.
    const h = harness();
    const composer = createNotesMethodComposer({
      methodFor: () => 'ledger-opus',
      apiKey: 'k-test',
      composerOpts: {
        apiKey: 'k-test',
        fetchImpl: h.impl,
        instructions: () => 'Write the meeting notes.',
      },
      ledgerFetch: h.impl,
    });
    if (!composer) throw new Error('no composer built');
    await composer.compose(input());
    expect(composes(h.seen)[0]?.system ?? '').not.toContain(STRENGTH_RULE);
  });
});
