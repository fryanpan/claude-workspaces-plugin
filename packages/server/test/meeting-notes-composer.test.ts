/**
 * The real notes composer's HTTP seam: what goes on the wire, where the cache
 * breakpoint lands, what comes back, and how a refusal is read — all through
 * a stubbed fetch, because a test that reached api.anthropic.com would spend
 * real money to assert string handling.
 *
 * What the prompt SAYS is next door in `notes-prompt-build.test.ts`; the two
 * split when the module did. The reply assertions are about EDITS rather than
 * a sanitized markdown string: the composer is handed an outline of blocks
 * with ids and answers with a JSON array.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  NOTES_MODEL,
  createHaikuNotesComposer,
  readNotesEdits,
} from '../src/meeting-notes-composer.ts';
import type { NotesComposer } from '../src/meeting-notes.ts';
import { isQuotaFailure } from '../src/model-quota.ts';
import { buildNotesPrompt } from '../src/notes-prompt-build.ts';
import type { NotesComposeMeasure } from '../src/notes-timing.ts';
import { input, withBullets } from './notes-compose-input.ts';

/** One edit, as a model would answer with it. */
const ONE_EDIT = '[{"op":"insert_under_heading","headingId":"h1","markdown":"- the sync is slow"}]';

/** A fetch stub that records the request and answers with `body`. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

/** The message a compose rejected with. Fails loudly if it resolved instead:
 *  a composer that returned edits would otherwise read as "not a quota
 *  refusal" and pass the negative case for the wrong reason. */
async function refusalOf(composer: NotesComposer | null): Promise<string> {
  try {
    await composer?.compose(input);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('compose resolved; expected it to reject');
}

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

  it('a reply it could not read throws, so the tick carries its words forward', () => {
    // Prose is the failure this contract exists to catch: the old composer
    // would have taken it as the notes.
    expect(() => readNotesEdits('## Meeting notes\n- a point')).toThrow('no usable edits');
    // Every entry discarded is the same failure: nothing usable came back.
    expect(() => readNotesEdits('[{"op":"teleport"}]')).toThrow('no usable edits');
  });

  it('a well-formed empty list is an answer, not a failure', () => {
    // A tick of greetings changes nothing, and `NotesComposer.compose`
    // documents that as legitimate. Throwing on it made every such tick a
    // compose failure whose turns were carried forward UNCAPPED, so a stretch
    // of small talk re-sent an ever-growing turn list to the model.
    expect(readNotesEdits('[]')).toEqual([]);
    expect(readNotesEdits('{"edits": []}')).toEqual([]);
    expect(readNotesEdits('```json\n[]\n```')).toEqual([]);
  });

  it('finds the array past a stray brace in the preamble', () => {
    // Taking whichever of `[` and `{` came first picked the brace here, and
    // the matching `}` closed before the array had opened — so the whole
    // reply parsed to nothing and a good tick was lost.
    expect(readNotesEdits(`Here's what I'd note {roughly}: ${ONE_EDIT}`)).toEqual([
      { op: 'insert_under_heading', headingId: 'h1', markdown: '- the sync is slow' },
    ]);
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
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(body.model).toBe(NOTES_MODEL);
    expect(body.messages[0]?.content.map((b) => b.text).join('\n\n')).toContain(
      'Measure before rewriting.',
    );
  });

  it('sends the prompt as the chunks it was cut into, marked where it said', async () => {
    // A marker in the wrong place is not a smaller win, it is no win at all:
    // one after this tick's speech would cache a prefix that never recurs,
    // and one on a block that grows every tick writes the whole prefix again.
    // MID-MEETING DOC, because a two-block doc is entirely live: a prompt
    // built from `input` has one chunk and one tail whatever the composer
    // does with them, so it cannot tell a sent ladder from a collapsed one.
    const midMeeting = withBullets(40);
    const { impl, calls } = stubFetch({
      content: [{ text: ONE_EDIT }],
      stop_reason: 'end_turn',
    });
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    await composer?.compose(midMeeting);
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      messages: Array<{ content: Array<{ text: string; cache_control?: { type: string } }> }>;
    };
    const blocks = body.messages[0]?.content ?? [];
    const built = buildNotesPrompt(midMeeting);
    // The control on the fixture: it really does have a ladder to collapse.
    expect(built.blocks.filter((b) => b.cached).length).toBeGreaterThan(1);
    // The wire carries the builder's own blocks, in its own order.
    expect(blocks.map((b) => b.text)).toEqual(built.blocks.map((b) => b.text));
    // A breakpoint on every block the builder marked, and on no other. The
    // LAST block is this tick's speech, and caching it would write an entry
    // nothing can ever read back.
    expect(blocks.map((b) => b.cache_control !== undefined)).toEqual(
      built.blocks.map((b) => b.cached),
    );
    expect(blocks[blocks.length - 1]?.cache_control).toBeUndefined();
    expect(blocks.filter((b) => b.cache_control !== undefined).length).toBeGreaterThan(0);
    for (const b of blocks) {
      if (b.cache_control !== undefined) expect(b.cache_control).toEqual({ type: 'ephemeral' });
    }
    // And nothing was lost or reordered in the cutting: what the model reads
    // is the whole prompt.
    expect(blocks.map((b) => b.text).join('')).toBe(built.user);
  });

  it('reports what the call cost in tokens, cache reads included', async () => {
    // The only number that can say whether the cache did anything: a marker
    // on a prompt under the model's minimum is ignored in silence, so a run
    // that caches nothing looks exactly like one that caches everything until
    // this is read back.
    const { impl } = stubFetch({
      content: [{ text: ONE_EDIT }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 310,
        output_tokens: 64,
        cache_read_input_tokens: 5100,
        cache_creation_input_tokens: 42,
      },
    });
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    const seen: NotesComposeMeasure[] = [];
    await composer?.compose({ ...input, measure: (m) => seen.push(m) });
    const usage = seen.find((m) => m.usage !== undefined)?.usage;
    expect(usage).toEqual({
      inputTokens: 310,
      outputTokens: 64,
      cacheReadTokens: 5100,
      cacheWriteTokens: 42,
    });
  });

  it('reports nothing rather than zeros when the reply carries no usage', async () => {
    // The control. Zeros here would read as "the cache returned nothing",
    // which is a claim about the API rather than about a missing field.
    const { impl } = stubFetch({ content: [{ text: ONE_EDIT }], stop_reason: 'end_turn' });
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    const seen: NotesComposeMeasure[] = [];
    await composer?.compose({ ...input, measure: (m) => seen.push(m) });
    expect(seen.some((m) => m.usage !== undefined)).toBe(false);
  });

  it('an HTTP failure rejects, so the session carries the words forward', async () => {
    const { impl } = stubFetch({ error: 'overloaded' }, 529);
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    expect(composer?.compose(input)).rejects.toThrow('529');
  });

  it('marks a 429 as a quota refusal, so the meeting can be told', async () => {
    const { impl } = stubFetch({ error: { message: 'rate limited' } }, 429);
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    expect(isQuotaFailure(await refusalOf(composer))).toBe(true);
  });

  it('marks the 400 whose body says the account is empty', async () => {
    // The shape the 2026-09-09 outage produced: a 400, not a 429, with the
    // account named in the body rather than in the status.
    const { impl } = stubFetch(
      { error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } },
      400,
    );
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    expect(isQuotaFailure(await refusalOf(composer))).toBe(true);
  });

  it('leaves an ordinary 400 unmarked — a bad request is this tick’s problem only', async () => {
    const { impl } = stubFetch(
      { error: { type: 'invalid_request_error', message: 'model: unknown model' } },
      400,
    );
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    expect(isQuotaFailure(await refusalOf(composer))).toBe(false);
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
