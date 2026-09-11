/**
 * What one tick ASKS the model, built to be cheap to ask again.
 *
 * The prompt is 98% of what a note costs: a tick sends about five and a half
 * thousand tokens and reads back a hundred. So the shape of this file is not
 * a matter of taste — it is the bill. Everything that repeats from tick to
 * tick is assembled first and handed back as one string (`stable`), and
 * everything about the tick in hand follows it (`volatile`), because a prompt
 * cache is a PREFIX match: one volatile line near the front and the whole
 * prompt is billed at full price again.
 *
 * The two rules that keeps on this file, and neither is enforceable by a
 * type: nothing that changes every tick may be appended to `stable`, and the
 * doc's outline may only GROW at its end — which is what
 * `NOTES_OUTLINE_DROP_STEP` is for. `meeting-notes-composer.ts` is where the
 * cache breakpoints are actually taken, on the boundaries `blocks` names.
 *
 * ONE BREAKPOINT WAS THE WRONG NUMBER, AND THE BILL SAID SO. A cached prefix
 * that GROWS is not a cheap prefix: measured against the API on 2026-09-10, a
 * request whose single cached block gained four lines read NOTHING from the
 * cache and wrote the whole block again at 1.25x. So the doc growing at its
 * end — the shape this file was built around — bought a full-price rewrite on
 * every tick that wrote a note, and an hour of EN2001a billed 1.06M cache
 * WRITES against 798k reads. Two breakpoints fix it: with the same four lines
 * added after an earlier breakpoint, the head reads from cache and only the
 * tail block is written. So the settled table is cut at QUANTIZED row counts
 * (`NOTES_OUTLINE_CACHE_STEPS`) that hold still while the doc grows past
 * them, and the last, smallest chunk is the only one an ordinary tick pays
 * to write.
 *
 * It came out of the composer when the cache did, because "what do we ask"
 * and "how do we ask it" stopped being one subject the moment the answer to
 * the first had to hold still.
 */

import type { NotesComposeInput, NotesTick, NotesTurn } from './meeting-notes.ts';
import { MEETING_NOTES_HEADING, NOTES_AUTHOR_ID } from './notes-doc-access.ts';
import { DEFAULT_NOTES_INSTRUCTIONS, withoutSpeakerAttribution } from './notes-prompt-store.ts';
import { regroupDirective } from './notes-regroup.ts';

/**
 * How much of the doc's body the outline may carry into one prompt.
 *
 * Headings are never dropped by the cap (`prose.readOutline`), so the model
 * can always see every topic and put a point under the right one; what this
 * bounds is the BULLETS, counted from the end of the doc. That is what keeps a
 * tick's prompt the size of the recent conversation rather than the size of
 * the meeting — the exact thing that made late ticks slow and then refused.
 * Eighty is generous against what a tick needs: a pause covers a minute or two
 * of speech and lands two or three bullets, so eighty is most of the last
 * half-hour of notes, and a point older than that belongs under a heading
 * rather than folded into a bullet the model can no longer see.
 */
export const NOTES_OUTLINE_RECENT_BLOCKS = 80;

/**
 * How many of those bullets the window lets go of at a time.
 *
 * A window that keeps exactly the last eighty drops its oldest line every
 * time the note-taker writes a new one, which means the doc block of the
 * prompt begins with different words on every tick — and a prompt cache is a
 * prefix match, so that alone is enough to make every tick pay full price for
 * the whole prompt. Dropping forty at once instead leaves the front of the
 * table untouched for forty bullets' worth of ticks, growing at the end,
 * which is exactly the shape a cache is cheap on.
 *
 * FORTY, not eighty and not five. The window holds between eighty and a
 * hundred and nineteen bullets, so the model is never shown less than it was
 * before and at most half as much again — and the front moves about once
 * every twenty ticks of an ordinary meeting rather than every one.
 */
export const NOTES_OUTLINE_DROP_STEP = 40;

/**
 * How many blocks at the live end of the doc stay OUT of the cached half.
 *
 * The note-taker revises what it just wrote, so the bottom of the table is
 * the part that changes; the cached prefix has to stop above it.
 *
 * FOUR, DOWN FROM TWELVE, AND THE LADDER IS WHY. Held-out rows are the one
 * part of the prompt nothing can cache — they are paid at full rate on every
 * tick of the meeting — so twelve of them cost about 470 tokens a tick. They
 * were worth it while a revision inside the cached half rewrote the WHOLE
 * prefix; with the chunk ladder a revision that deep rewrites one chunk, so
 * the insurance stopped being worth its premium. Measured over the 306 ticks
 * of EN2001a, twelve cost $0.90 against four's $0.79, and the plateau around
 * four is flat: three and six are within a cent.
 *
 * It changes nothing the model READS. The rows either side of the cut are the
 * same rows in the same order; the cut decides only which content block
 * carries them.
 */
export const NOTES_OUTLINE_LIVE_BLOCKS = 4;

/**
 * The most cache breakpoints one request may carry. Anthropic's limit, and
 * the reason `NOTES_OUTLINE_CACHE_STEPS` has room for three entries and not
 * four: the settled table's own end is always a breakpoint too.
 */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Where the settled table is cut into cache blocks, coarsest first.
 *
 * A breakpoint only pays if the text BEFORE it is byte-identical to some
 * earlier tick's. Cutting at "everything but the last few rows" is not that:
 * the boundary moves every time a note is written, so nothing before it ever
 * repeats. Cutting at a MULTIPLE of sixty-four rows is: the boundary holds
 * still for sixty-four notes, and the chunk after it holds still for sixteen,
 * and the one after that for four.
 *
 * So an ordinary tick reads everything up to the last boundary the doc has
 * not yet grown past and writes only the rows beyond it — four rows, not five
 * thousand tokens. One tick in four writes sixteen rows, one in sixteen
 * writes sixty-four, and one in sixty-four writes the lot.
 *
 * 64/16/4, measured. The sweep over EN2001a's 306 recorded ticks is flat
 * between 64/12/4 and 64/24/8 (all within a cent of $0.79) and falls off
 * either side: 128/16/4 costs $1.04 because the coarse anchor is so rarely
 * reached, and one step alone costs $1.33.
 */
export const NOTES_OUTLINE_CACHE_STEPS: readonly number[] = [64, 16, 4];

/** The heading a meeting's section is opened under, as one markdown line. */
const HEADING_LINE = `## ${MEETING_NOTES_HEADING}`;

/** One content block of the user message, and whether a breakpoint ends it. */
export interface NotesPromptBlock {
  text: string;
  /** True when a cache breakpoint is taken at the END of this block. */
  cached: boolean;
}

/**
 * What one tick asks the model, cut into the blocks it is sent as.
 *
 * `blocks` is the wire form: the cached chunks in order, then the one block
 * about this tick. Concatenating every `text` gives `user` EXACTLY, which is
 * what the model reads — so a block that forgets its own separator is a
 * corrupted prompt, not a formatting nit. It is also why every block after
 * the first carries its leading newline: the first cut sent two blocks that
 * butted a settled row straight against a live one, with no line break
 * anywhere between them.
 *
 * `stable` is every cached chunk joined — everything that reads the same from
 * one tick to the next. `volatile` is everything about THIS tick. `user` is
 * the two joined, which is what every caller that only wants the words reads.
 */
export interface NotesPrompt {
  system: string;
  blocks: readonly NotesPromptBlock[];
  /** The cacheable head of the user message, and the tail after it. */
  stable: string;
  volatile: string;
  /** `stable` and `volatile` joined — the prompt as one string. */
  user: string;
}

/**
 * Prompt building is pure and exported: what the transcript is asked to
 * become is behaviour worth pinning without a network in the test.
 *
 * `instructions` is the system prompt — the note-taking rules, which now come
 * from a store rather than from a literal here (`notes-prompt-store.ts`).
 * They default to the stored default, so every existing caller and every test
 * that built a prompt without one still gets the words it always got.
 *
 * STABLE MATERIAL FIRST, AND THAT IS THE WHOLE REASON THE ORDER IS WHAT IT IS
 * (Bryan, 2026-09-10: "if we're sending the meeting context, I'd rather it hit
 * cache every time and grow rather than sending new context each time").
 * A prompt cache is a PREFIX match: one changed byte anywhere before the
 * breakpoint and everything after it is billed fresh. So the doc — the
 * biggest block in the prompt, and one that grows by a bullet or two a tick
 * rather than being rewritten — moved from last-but-one to second, ahead of
 * every block that is about this tick alone. Nothing was added or removed;
 * one block changed places, and `NOTES_OUTLINE_RECENT_BLOCKS`' window learned
 * to jump in steps rather than slide by one (`prose.readOutline`), because a
 * window that drops its oldest line every tick has no stable prefix to cache.
 */
export function buildNotesPrompt(
  input: NotesComposeInput,
  instructions: string = DEFAULT_NOTES_INSTRUCTIONS,
): NotesPrompt {
  // A SOLO MEETING IS SENT NO ATTRIBUTION RULES. Its transcript lines carry
  // no name — the session strips them until a second voice is heard — so
  // rules demanding a speaker tag on every note, and spelling "Speaker B" as
  // what such a name looks like, are asking for something the model can only
  // supply by inventing it. That is the phantom, named in the prompt before
  // the composer ever wrote it.
  const system =
    input.multiSpeaker === false ? withoutSpeakerAttribution(instructions) : instructions;

  const parts: string[] = [];
  const ctx = input.context;
  const ctxLines: string[] = [];
  if (ctx?.docTitle) ctxLines.push(`- Meeting doc: ${ctx.docTitle}`);
  if (ctx?.repoRoot) ctxLines.push(`- Repository: ${ctx.repoRoot}`);
  if (ctx?.docPaths?.length) ctxLines.push(`- Project docs: ${ctx.docPaths.join(', ')}`);
  if (ctx?.taskTitles?.length) {
    ctxLines.push('- Open board tasks (the work likely under discussion):');
    for (const title of ctx.taskTitles) ctxLines.push(`  - ${title}`);
  }
  if (ctxLines.length > 0) parts.push(`Project context:\n${ctxLines.join('\n')}`);
  // THE FIRST CACHE BLOCK. Everything above reads the same all meeting, and
  // the settled table follows it in chunks whose boundaries hold still while
  // the doc grows. The doc's LIVE end and everything about this tick go after
  // the last breakpoint, because those are what change.
  const doc = renderOutline(input);
  parts.push(doc.chunks[0] ?? '');
  const cached: NotesPromptBlock[] = [
    { text: parts.join('\n\n'), cached: true },
    // Each later chunk carries the newline that joins it to the one before,
    // so the settled table reads as one table however it was cut.
    ...doc.chunks.slice(1).map((text) => ({ text: `\n${text}`, cached: true })),
  ];
  const stable = cached.map((b) => b.text).join('');
  parts.length = 0;
  if (doc.tail.length > 0) parts.push(doc.tail);
  // IMMEDIATELY AFTER THE TABLE, because it is about the table: a directive
  // naming block ids reads as an instruction about the rows above it, and
  // three blocks of board material in between is what made it read as
  // background. It cannot go in the cached head — it is recomputed from the
  // outline every tick and turns on and off as a topic fills up.
  const regroup = regroupDirective(input.outline, {
    author: NOTES_AUTHOR_ID,
    notesHeadingId: input.notesHeadingId,
  });
  if (regroup) parts.push(regroup);

  if (input.taskLinks?.length) {
    parts.push(
      [
        'Board tasks captured from this speech. Where a note covers one, cite',
        'it as a markdown link — [its title](its url), or your own words as',
        'the label when the note reads better that way. Keep links already in',
        'the notes.',
        ...input.taskLinks.map((l) => `- [${l.title}](${l.url}) — ${l.status}`),
      ].join('\n'),
    );
  }

  if (input.docLinks?.length) {
    parts.push(
      [
        'Material somebody in this meeting asked to have pulled in, already',
        'found. Cite it in the note that asked for it, as a markdown link.',
        'Do not summarize what is inside it — you have not read it, and the',
        'link is the answer.',
        ...input.docLinks.map((l) => `- [${l.title}](${l.url})${l.when ? ` — ${l.when}` : ''}`),
      ].join('\n'),
    );
  }

  if (input.references?.length) {
    parts.push(
      [
        'Named in this speech, and already on the board. Where a note covers',
        'one, write its name as a markdown link — [its title](its url) — the',
        'first time that note mentions it. Do not add one to a note that is',
        'not about it, and do not link the same thing twice in one note.',
        ...input.references.map(
          (r) => `- [${r.title}](${r.url}) — ${r.kind}${r.when ? `, met ${r.when}` : ''}`,
        ),
      ].join('\n'),
    );
  }

  if (input.missed?.length) {
    parts.push(
      [
        'SAID EARLIER AND STILL IN NO NOTE. Each of these went past without',
        'producing anything. Read them again with the notes above in front of',
        'you: write the note each one should have produced, under the heading',
        'it belongs to. Leave one out only if it is genuinely packaging — a',
        'greeting, a false start, or a point the notes already carry in other',
        'words. This is their last offer; nothing asks again.',
        ...input.missed.map((t) => `- ${speakerPrefix(t)}${t.text}`),
      ].join('\n'),
    );
  }

  if (input.extraPrompt) parts.push(input.extraPrompt);
  parts.push(
    `New transcript since the last update:\n${input.tick.turns
      .map((t) => `- ${speakerPrefix(t)}${t.text}${turnSuffix(t, input.tick.reason)}`)
      .join('\n')}`,
  );
  const volatile = parts.join('\n\n');
  const blocks: NotesPromptBlock[] = [...cached, { text: `\n\n${volatile}`, cached: false }];
  return { system, blocks, stable, volatile, user: `${stable}\n\n${volatile}` };
}

/**
 * Where the settled table is cut, in row counts, coarsest boundary first.
 *
 * Every cut but the last is a multiple of one of `NOTES_OUTLINE_CACHE_STEPS`,
 * which is the whole point: those numbers do not move when the doc grows by a
 * row, so the text before them repeats and can be read rather than written.
 * The last cut is the end of the settled table itself, wherever that falls.
 *
 * Duplicates are dropped rather than sent as empty blocks — a doc of exactly
 * sixty-four settled rows has every step landing on the same row — which is
 * also what keeps the count inside `MAX_CACHE_BREAKPOINTS`.
 */
export function outlineCacheCuts(
  settled: number,
  steps: readonly number[] = NOTES_OUTLINE_CACHE_STEPS,
): number[] {
  const cuts: number[] = [];
  const last = (): number => cuts[cuts.length - 1] ?? 0;
  for (const step of steps) {
    const at = Math.floor(settled / step) * step;
    if (at > last()) cuts.push(at);
  }
  if (settled > last()) cuts.push(settled);
  return cuts;
}

/**
 * The doc as the model addresses it: one line per block, carrying the id an
 * edit comes back with, what kind of block it is, whose it is, and its words.
 *
 * DELIBERATELY NOT MARKDOWN. Handing the model the section as prose is what
 * made it answer with prose — a whole rewritten section, indistinguishable
 * from the one it was given except where it had changed its mind. A table of
 * ids is a different question: it can only be answered by naming blocks.
 *
 * "yours" and "theirs" are read off `author`, which the doc clears the moment
 * a person edits a block (`clearAuthorshipOnPersonEdit`). So "yours" means
 * "you wrote this and nobody has touched it since", which is exactly the set
 * of blocks an edit may rewrite directly — anything else reaches them as a
 * suggestion, and the instructions say so.
 */
/**
 * The doc as the model reads it, cut into the chunks the cache is taken on.
 *
 * `chunks` is the settled table — every block but the last
 * `NOTES_OUTLINE_LIVE_BLOCKS` — split at `outlineCacheCuts`; `tail` is those
 * last blocks. The tail is held out because of what a note-taker DOES: it
 * revises the bullet it wrote a moment ago. Measured over 305 consecutive
 * tick pairs of an hour of EN2001a, 66% of them changed the doc only within
 * its last four blocks, and 88% within its last twelve. A prompt cache is a
 * prefix match, so a revised line inside a chunk throws that chunk and every
 * chunk after it back to full price — which is why the chunks get smaller
 * towards the live end, where the revisions are.
 *
 * They are rendered as one table and joined back in order, so the rows the
 * model reads are the same rows in the same order — what changes is that a
 * blank line falls between the settled part and the live end, and that on the
 * wire they are several content blocks.
 */
function renderOutline(input: NotesComposeInput): { chunks: string[]; tail: string } {
  if (input.outline.length === 0) {
    return {
      chunks: [
        [
          'The doc is empty, and this meeting has no notes section yet.',
          `Open one with a single insert_at_end carrying "${HEADING_LINE}", then`,
          'insert_at_end the first notes under it.',
        ].join('\n'),
      ],
      tail: '',
    };
  }
  const lines = input.outline.map((entry) => {
    const kind =
      entry.kind === 'heading'
        ? `h${entry.level ?? 2}`
        : entry.kind === 'listItem'
          ? // A GROUPED TOPIC HAS TO READ AS GROUPED. Every bullet used to
            // print as `bullet`, so a topic already gathered under lead
            // bullets was indistinguishable from a wall — which made the
            // instruction to regroup one impossible to act on and impossible
            // to stop acting on. `sub-bullet` is the whole difference.
            (entry.depth ?? 0) > 0
            ? 'sub-bullet'
            : 'bullet'
          : 'para';
    const whose = entry.author === undefined ? 'theirs' : 'yours';
    const under =
      entry.kind === 'heading' || entry.underHeadingId === undefined
        ? ''
        : ` under=${entry.underHeadingId}`;
    return `${entry.id} ${kind} ${whose}${under} | ${entry.text}`;
  });
  const preamble =
    input.notesHeadingId === undefined
      ? [
          'This meeting has NO notes section in the doc below.',
          `Open one with a single insert_at_end carrying "${HEADING_LINE}".`,
        ]
      : [`This meeting's notes are under heading ${input.notesHeadingId}.`];
  // Never cut so deep that the first chunk is a preamble with no table under
  // it: a short doc stays whole and the tail is empty, which is the same
  // prompt the whole thing was before.
  const settled = Math.max(0, lines.length - NOTES_OUTLINE_LIVE_BLOCKS);
  const head = [
    ...preamble,
    '',
    'The doc, block by block — "id kind whose | text". Only the most recent',
    'blocks are listed; every heading is. A "sub-bullet" sits under the',
    '"bullet" above it.',
  ].join('\n');
  const chunks: string[] = [];
  let from = 0;
  for (const to of outlineCacheCuts(settled)) {
    chunks.push(lines.slice(from, to).join('\n'));
    from = to;
  }
  // The preamble rides the first chunk, and is the whole of it when the table
  // has no settled rows yet.
  if (chunks.length === 0) chunks.push(head);
  else chunks[0] = `${head}\n${chunks[0]}`;
  return { chunks, tail: lines.slice(settled).join('\n') };
}

/**
 * How an unfinished sentence is presented, and what makes it unfinished.
 *
 * Two things reach the composer as fragments now, and they are not the same
 * fact. The last sentence of a MEETING is cut off because the recording
 * stopped; a sentence carried by a ceiling tick is cut off because the
 * speaker is still saying it. A composer told the recording stopped, in the
 * middle of a meeting that is still going, is being misinformed — it was one
 * string when only the final tick could carry a fragment.
 *
 * Either way it is the engine's raw text: no punctuation, no sentence
 * casing, sometimes cut mid-word. Saying so is what stops the note-taker
 * rendering a fragment as a finished point — the instructions already ask it
 * to end a note it is unsure of with `(unconfirmed)`, and this is that case
 * named on the wire.
 */
const PARTIAL_SUFFIX = ' [unfinished — the recording stopped mid-sentence]';
const STILL_SPEAKING_SUFFIX = ' [unfinished — they are still saying it]';

/**
 * And how the REST of a sentence is presented, once its earlier words have
 * already been written.
 *
 * A ceiling tick hands over as much of a long turn as the engine has
 * committed to, and the remainder arrives on a later tick. Without this the
 * remainder reads as a new thought and the note-taker opens a second point
 * for the second half of one sentence — which is the whole reason the ticker
 * marks it.
 */
const CONTINUED_SUFFIX = ' [continues a sentence already in the notes]';

/** The markers one transcript line carries, in reading order. */
function turnSuffix(t: NotesTurn, reason: NotesTick['reason']): string {
  const continued = t.continued ? CONTINUED_SUFFIX : '';
  if (!t.partial) return continued;
  return `${continued}${reason === 'end' ? PARTIAL_SUFFIX : STILL_SPEAKING_SUFFIX}`;
}

/**
 * "Devi (B): " — the name to write and the label to tag with, in the one
 * place the composer reads them from. A turn the session never mapped a
 * label onto keeps the bare name; a turn with no voice at all keeps none.
 */
function speakerPrefix(turn: NotesTurn): string {
  if (!turn.speaker) return '';
  return turn.speakerLabel ? `${turn.speaker} (${turn.speakerLabel}): ` : `${turn.speaker}: `;
}
