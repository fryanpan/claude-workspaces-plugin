/**
 * The shape of a tick's cacheable prefix, so a tick that read nothing from
 * the cache can say WHY.
 *
 * WHAT COULD NOT BE ANSWERED BEFORE THIS FILE. The timing row already carries
 * `cacheReadTokens`, so the corpus can say that 192 of one meeting's 414
 * ticks read anything from the cache. It cannot say what the other 222 had
 * wrong, and the two candidates need opposite fixes:
 *
 *   - THE FLOOR. Nothing caches until the text before a breakpoint clears
 *     the model's minimum cacheable prefix — 4,096 tokens on Haiku 4.5,
 *     measured against the API on 2026-09-15 (`notes-prompt-build.ts` has the
 *     probe). The first breakpoint sits at a multiple of sixty-four doc rows,
 *     so early in a meeting it is simply too short and every tick pays full
 *     price however stable it is. Nothing is wrong and nothing can be done in
 *     the prompt builder.
 *   - A MOVED PREFIX. A row inside the first cached block changed — a
 *     regroup, a heading rename, a correction deep in the doc, a person
 *     editing — so the prefix is new text and there is nothing to read. This
 *     one IS the prompt builder's business, and it is invisible in the log.
 *
 * `stableBlocks` separates them in one number: zero means the first block's
 * own text moved, and anything above zero means the head repeated and the
 * miss is the floor (or the entry's five-minute life) rather than the shape.
 *
 * HASHES, NEVER TEXT — the same rule as every other field in the timing file.
 * What this module keeps between ticks is a digest per block; the words are
 * in the transcript beside the log, and a second copy of them in a different
 * shape would be a second thing to protect.
 *
 * IT IS A WATCHER AND NOT A GATE. Nothing here changes a prompt, a
 * breakpoint, or whether a call is made. A watcher that threw, or that grew
 * without bound over a day of meetings, would cost a meeting its notes for an
 * instrument nobody was reading, so it does neither: every path returns a
 * shape, and the map holds a fixed number of meetings.
 */

import { createHash } from 'node:crypto';

/** One block of the user message, as `notes-prompt-build.ts` cuts them. */
export interface CacheShapeBlock {
  text: string;
  cached: boolean;
}

export interface PromptCacheShape {
  /** How many cache breakpoints this request carries. */
  blocks: number;
  /**
   * Characters before the FIRST breakpoint.
   *
   * The one that has to clear the model's minimum on its own, which is why it
   * is here rather than the whole head: a prompt can be thirty thousand
   * characters long and still cache nothing because its first block is two
   * thousand of them.
   */
  firstBlockChars: number;
  /**
   * How many LEADING cached blocks are byte-identical to the previous tick's
   * — the most this request could read rather than write.
   *
   * `null` on the first tick of a meeting: there is no previous prompt, so
   * "did it repeat" has no answer, and zero would read as a moved prefix.
   */
  stableBlocks: number | null;
}

export interface PromptCacheWatcher {
  /**
   * The shape of this tick's prefix, against the last one on the same
   * meeting. `key` identifies the meeting — two recordings on one doc are two
   * conversations and must not be compared to each other.
   */
  shapeOf(key: string, blocks: readonly CacheShapeBlock[]): PromptCacheShape;
}

/**
 * How many meetings' hashes are held at once.
 *
 * Small because the answer is only ever about the PREVIOUS tick of the SAME
 * meeting: the map exists so that concurrent recordings do not overwrite each
 * other, not as a history. Eight is more concurrent meetings than this server
 * has ever run, and the oldest entry is dropped rather than the newest
 * refused.
 */
const MAX_MEETINGS = 8;

const digest = (text: string): string => createHash('sha1').update(text, 'utf8').digest('base64');

export function createPromptCacheWatcher(opts: { maxMeetings?: number } = {}): PromptCacheWatcher {
  const limit = opts.maxMeetings ?? MAX_MEETINGS;
  /** Insertion-ordered by Map contract, which is what makes the eviction
   *  below "the least recently used" — every read re-inserts its key. */
  const previous = new Map<string, readonly string[]>();
  return {
    shapeOf(key, blocks): PromptCacheShape {
      const cached = blocks.filter((b) => b.cached);
      const hashes = cached.map((b) => digest(b.text));
      const before = previous.get(key);
      let stable: number | null = null;
      if (before !== undefined) {
        stable = 0;
        while (stable < hashes.length && hashes[stable] === before[stable]) stable++;
      }
      previous.delete(key);
      previous.set(key, hashes);
      while (previous.size > limit) {
        const oldest = previous.keys().next();
        if (oldest.done === true) break;
        previous.delete(oldest.value);
      }
      return {
        blocks: cached.length,
        firstBlockChars: cached[0]?.text.length ?? 0,
        stableBlocks: stable,
      };
    },
  };
}
