/**
 * The watcher that says why a tick read nothing from the cache.
 *
 * The question every case here is about: given two consecutive prompts, how
 * much of the cacheable head repeated? Zero is a moved prefix and anything
 * above zero is the model's minimum (or the entry's life) — the two causes
 * the timing log could not tell apart.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { type CacheShapeBlock, createPromptCacheWatcher } from '../src/notes-prompt-cache-shape.ts';

/** A prompt as the builder cuts it: cached chunks, then the tick's own block. */
const promptOf = (...cached: string[]): CacheShapeBlock[] => [
  ...cached.map((text) => ({ text, cached: true })),
  { text: 'New transcript since the last update:\n- and then we shipped it', cached: false },
];

const HEAD = 'Project context:\n- Meeting doc: Riverbend planning';
const TABLE = 'b1 bullet yours | the sync is the bottleneck';

describe('the prompt cache watcher', () => {
  it("a meeting's first tick reports no repeat rather than a broken one", () => {
    // Null and zero are different claims: zero says the prefix moved, which
    // would be a finding about the prompt builder on a tick that had nothing
    // to move from.
    const watcher = createPromptCacheWatcher();
    const shape = watcher.shapeOf('doc-a|m-1', promptOf(HEAD, TABLE));
    expect(shape.stableBlocks).toBeNull();
    expect(shape.blocks).toBe(2);
    expect(shape.firstBlockChars).toBe(HEAD.length);
  });

  it('a second tick that changed only its speech repeated the whole head', () => {
    const watcher = createPromptCacheWatcher();
    watcher.shapeOf('doc-a|m-1', promptOf(HEAD, TABLE));
    const second = watcher.shapeOf('doc-a|m-1', [
      { text: HEAD, cached: true },
      { text: TABLE, cached: true },
      { text: 'New transcript since the last update:\n- something else entirely', cached: false },
    ]);
    expect(second.stableBlocks).toBe(2);
  });

  it('a row changing inside the FIRST block reports nothing stable', () => {
    // The finding this whole file exists for: the head moved, so the tick
    // could not have read anything however big the prompt was.
    const watcher = createPromptCacheWatcher();
    watcher.shapeOf('doc-a|m-1', promptOf(HEAD, TABLE));
    const after = watcher.shapeOf('doc-a|m-1', promptOf(`${HEAD}\n- Repository: /repo`, TABLE));
    expect(after.stableBlocks).toBe(0);
  });

  it('a row changing in a LATER block keeps the blocks before it', () => {
    // The ladder working as designed: a revision near the live end throws one
    // chunk back to full price and the head is still read.
    const watcher = createPromptCacheWatcher();
    watcher.shapeOf('doc-a|m-1', promptOf(HEAD, TABLE));
    const after = watcher.shapeOf('doc-a|m-1', promptOf(HEAD, `${TABLE}\nb2 bullet yours | new`));
    expect(after.stableBlocks).toBe(1);
  });

  it('the head growing by a whole new chunk keeps the chunks under it', () => {
    const watcher = createPromptCacheWatcher();
    watcher.shapeOf('doc-a|m-1', promptOf(HEAD, TABLE));
    const after = watcher.shapeOf('doc-a|m-1', promptOf(HEAD, TABLE, 'b9 bullet yours | later'));
    expect(after.stableBlocks).toBe(2);
    expect(after.blocks).toBe(3);
  });

  it('two meetings on one doc are not compared to each other', () => {
    // A second recording opens a new conversation; its first tick has no
    // previous prompt of its own, and reading the earlier meeting's would
    // report a moved prefix that never happened.
    const watcher = createPromptCacheWatcher();
    watcher.shapeOf('doc-a|m-1', promptOf(HEAD, TABLE));
    expect(watcher.shapeOf('doc-a|m-2', promptOf(HEAD, TABLE)).stableBlocks).toBeNull();
  });

  it('the uncached tail is not counted, however much it moved', () => {
    // It carries this tick's speech, so it moves every time by design. A
    // watcher that counted it would report a moved prefix on every tick of
    // every meeting.
    const watcher = createPromptCacheWatcher();
    watcher.shapeOf('doc-a|m-1', promptOf(HEAD, TABLE));
    const after = watcher.shapeOf('doc-a|m-1', [
      { text: HEAD, cached: true },
      { text: TABLE, cached: true },
      { text: 'a completely different tail', cached: false },
    ]);
    expect(after.blocks).toBe(2);
    expect(after.stableBlocks).toBe(2);
  });

  it('holds a fixed number of meetings, and the one it drops is the oldest', () => {
    // A day of meetings must not grow this map. The eviction is only safe
    // because a dropped meeting reports null — an unknown — rather than a
    // moved prefix.
    const watcher = createPromptCacheWatcher({ maxMeetings: 2 });
    watcher.shapeOf('doc-a|m-1', promptOf(HEAD, TABLE));
    watcher.shapeOf('doc-b|m-1', promptOf(HEAD, TABLE));
    watcher.shapeOf('doc-c|m-1', promptOf(HEAD, TABLE));
    expect(watcher.shapeOf('doc-a|m-1', promptOf(HEAD, TABLE)).stableBlocks).toBeNull();
    expect(watcher.shapeOf('doc-c|m-1', promptOf(HEAD, TABLE)).stableBlocks).toBe(2);
  });

  it('a prompt with no breakpoints at all reports a zero-length first block', () => {
    const watcher = createPromptCacheWatcher();
    const shape = watcher.shapeOf('doc-a|m-1', [{ text: 'just the speech', cached: false }]);
    expect(shape.blocks).toBe(0);
    expect(shape.firstBlockChars).toBe(0);
  });
});
