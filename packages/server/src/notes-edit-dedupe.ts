/**
 * The note-taker writes each topic heading once and each note once, whatever
 * the model answers.
 *
 * WHY THIS EXISTS. On 2026-09-14 a three-minute solo meeting left a doc with
 * the same topic heading four and five times, most with nothing under them,
 * and its first flat bullets still standing after the same points had been
 * restated under those headings. Replayed through this pipeline with the
 * production model, the shapes behind it were:
 *
 * - **A heading the section already has, opened again.** The prompt says not
 *   to, and a tick does it anyway: it has just opened `### Ferry timetable`
 *   and cannot address it by id in the same batch, or it reads the outline
 *   and misses a heading several blocks up. `notes-section-tidy.ts` folds a
 *   repeat only when it sits straight after the topic it repeats, which a
 *   heading appended at the end of the section almost never does.
 * - **A note restated word for word.** The model moves a point by writing it
 *   again under the topic it belongs to, and never deletes the original, so
 *   the point stands twice — or three times, once per regroup.
 * - **A decision nobody took.** A speaker describing a habit of theirs came
 *   back as a `**Decision:**` note, with nothing in the speech deciding it.
 *
 * WHAT IT DOES, per edit that inserts markdown, before the batch is applied:
 *
 * 1. A heading line whose topic matches a heading already inside this
 *    meeting's section is taken out, and the lines under it are re-addressed
 *    to THAT heading. A new heading repeated inside one batch is merged into
 *    its first occurrence.
 * 2. A bullet whose note is already in the section is not written again. When
 *    the earlier copy is the note-taker's own, has nothing nested under it, is
 *    under a different heading and nobody has commented on it, the new copy is
 *    the note-taker MOVING it: the new one lands and the old one is deleted, so
 *    the note ends up once, under its topic. Otherwise the new copy is dropped.
 * 3. A `Decision:` label on a note is removed when nothing in this tick's
 *    speech states a decision. The note stays; only the label goes.
 *
 * WHICH WAY IT ERRS. Rule 2 matches a normalised note, or one whose content
 * words are nearly all the same, so a note reworded heavily still lands twice.
 * That is the direction a missed idea cannot come from: nothing here removes a
 * note whose words are not in the doc afterwards. Rule 3 is lexical too, and
 * a decision spoken without any of its cue words loses its label, not its
 * note.
 */

import type { prose } from '@claude-workspaces/core';
import { sectionIds } from './notes-cleanup-scope.ts';
import { contentWords, negates } from './notes-idea-coverage.ts';
import { topicKey } from './notes-quality.ts';

export interface NotesDedupeContext {
  /** This meeting's own section heading, when it has one. */
  notesHeadingId: string | undefined;
  /** The doc as it stands before the batch. */
  outline: readonly prose.OutlineEntry[];
  /** The words this tick composed from. */
  speech: readonly string[];
  /** The note-taker's own author id: only its notes are ever moved. */
  authorId: string;
  /** Blocks somebody has commented on — never deleted by a move. */
  commented?: () => ReadonlySet<string>;
  /**
   * What the section already held when this meeting took it over — the last
   * recording's minutes. A note there is not this meeting's to repeat: the
   * same words said in two meetings are two notes. Topic headings there are
   * still reused, because a note added under one changes nothing it holds.
   */
  prior?: ReadonlySet<string>;
}

export interface NotesDedupeResult {
  edits: prose.BlockEdit[];
  /** One line per change, for the log. Empty on the ordinary batch. */
  notes: string[];
  /** Notes left out because the section already carries them. Their words
   *  are in the doc, which a caller deciding "did this tick land" needs. */
  alreadyWritten: number;
}

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
/** A line of words that is not a bullet, a quote, a table row or code. */
const PLAIN_NOTE = /^()([\p{L}\p{N}*_[].*\S)\s*$/u;
/** A leading `**Decision:**`, after the bullet marker when there is one. */
const DECISION_LABEL = /^(\s*(?:[-*+]|\d+[.)])\s+)?\*{0,2}decision\*{0,2}\s*:\s*\*{0,2}\s*/i;

/**
 * What a speaker says when they decide something. Lexical and deliberately
 * short: a phrase missing here costs a label, and a phrase too loose puts the
 * invented decision back.
 */
const DECISION_CUE =
  /\b(let'?s|let us|we'?ll|we will|we'?re going to|we are going to|i'?ll|i will|decided?|decision|agreed?|going with|go with|settled on)\b/i;

/** The note a bullet line carries, with its packaging taken off: a speaker
 *  tag, link syntax, emphasis and a leading label. */
export function noteKey(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\[@[^\]]*\]\(speaker:[^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/^\s*(decision|question|action|next step)\s*:/i, '')
    .replace(/\(unconfirmed\)/gi, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Whether two topic headings name one topic: the same words, or one's content
 * words inside the other's (at least two of them), or most of them shared.
 *
 * LOOSER THAN A NOTE, because what a heading costs when it is wrongly merged
 * is a group of notes under a broader name, and what it costs when it is
 * wrongly kept is the doc the reader saw: `User feedback on harbour review`,
 * `Initial feedback on harbour review` and `Harbour review`, one topic three
 * times.
 */
export function sameTopic(a: string, b: string): boolean {
  const ka = topicKey(a);
  const kb = topicKey(b);
  if (ka.length === 0 || kb.length === 0) return false;
  if (ka === kb) return true;
  const wa = new Set(contentWords(ka));
  const wb = new Set(contentWords(kb));
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  const smaller = Math.min(wa.size, wb.size);
  if (smaller >= 2 && shared === smaller) return true;
  return shared / (wa.size + wb.size - shared) >= 0.6;
}

/** Whether two notes say the same thing: the same words once normalised, or
 *  at least three content words with nearly all of them shared — and never
 *  when one says the opposite of the other. */
export function sameNote(a: string, b: string): boolean {
  const ka = noteKey(a);
  const kb = noteKey(b);
  if (ka.length === 0 || kb.length === 0) return false;
  if (ka === kb) return true;
  // Read off the lines as written: the key has already split `don't`.
  if (negates(a) !== negates(b)) return false;
  const wa = new Set(contentWords(ka));
  const wb = new Set(contentWords(kb));
  if (wa.size < 3 || wb.size < 3) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared) >= 0.8;
}

interface Segment {
  heading?: { level: number; text: string };
  lines: string[];
}

/** A fenced code block is carried as ONE line with its newlines inside: a
 *  `# comment` in it is no heading and a `- item` in it is no note, and a
 *  string starting with a fence matches neither pattern. */
function segmentsOf(markdown: string): Segment[] {
  const out: Segment[] = [{ lines: [] }];
  const raw = markdown.split('\n');
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i] ?? '';
    const fence = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (fence !== undefined) {
      let end = i + 1;
      while (end < raw.length && !(raw[end] ?? '').trim().startsWith(fence)) end++;
      (out[out.length - 1] as Segment).lines.push(raw.slice(i, end + 1).join('\n'));
      i = end;
      continue;
    }
    const m = line.match(HEADING);
    if (m) out.push({ heading: { level: (m[1] ?? '#').length, text: m[2] ?? '' }, lines: [] });
    else (out[out.length - 1] as Segment).lines.push(line);
  }
  return out;
}

function hasWords(lines: readonly string[]): boolean {
  return lines.some((l) => /[\p{L}\p{N}]/u.test(l));
}

/** Whether the line after `i` carries on the same block: text at the margin
 *  that is neither a bullet nor a fence. */
function runsOn(lines: readonly string[], i: number): boolean {
  const next = lines[i + 1];
  if (next === undefined || next.trim() === '') return false;
  return !BULLET.test(next) && !/^\s*(`{3,}|~{3,})/.test(next) && !/^\s/.test(next);
}

/** Whether the line at `i` has a more-indented line under it. */
function hasChildren(lines: readonly string[], i: number, indent: number): boolean {
  for (let j = i + 1; j < lines.length; j++) {
    const next = lines[j] ?? '';
    if (next.trim() === '') continue;
    return (next.match(/^\s*/)?.[0].length ?? 0) > indent;
  }
  return false;
}

export function dedupeNotesEdits(
  edits: readonly prose.BlockEdit[],
  ctx: NotesDedupeContext,
): NotesDedupeResult {
  const notes: string[] = [];
  const headingId = ctx.notesHeadingId;
  const outline = ctx.outline;
  // No section yet is the tick that opens one: nothing to repeat, and a label
  // on its first note is judged all the same.
  const section =
    headingId === undefined
      ? { blocks: new Set<string>(), headings: new Set<string>() }
      : sectionIds(outline, headingId);
  // No speech is a caller that cannot say what the tick heard — a section
  // open, a cleanup — not a tick that heard no decision.
  const decided = ctx.speech.length === 0 || ctx.speech.some((s) => DECISION_CUE.test(s));

  /** The topic headings already in the section. */
  const topics: Array<{ id: string; level: number; text: string }> = [];
  let lastHeading: string | undefined = headingId;
  const headings = new Set<string>();
  for (const e of outline) {
    if (e.kind === 'heading') headings.add(e.id);
    if (!section.blocks.has(e.id) || e.kind !== 'heading') continue;
    lastHeading = e.id;
    if (e.id === headingId) continue;
    if (topicKey(e.text).length > 0) topics.push({ id: e.id, level: e.level ?? 1, text: e.text });
  }
  /** The section's notes as they stand, with what a move needs to know. */
  const existing = outline
    .map((e, i) => ({ e, next: outline[i + 1] }))
    .filter(
      ({ e }) => e.kind === 'listItem' && section.blocks.has(e.id) && ctx.prior?.has(e.id) !== true,
    )
    .map(({ e, next }) => ({
      entry: e,
      leaf: !(next?.kind === 'listItem' && (next.depth ?? 0) > (e.depth ?? 0)),
    }));
  // A bullet the batch also rewrites is not deleted by a move: the replace
  // gives it its new words, and the restated copy is where the old ones went.
  const taken = new Set<string>(
    edits.flatMap((e) => (e.op === 'replace_block' ? [e.blockId] : [])),
  );
  const written: string[] = [];
  let alreadyWritten = 0;
  /** A label the doc already carries was judged by the tick that wrote it: a
   *  regroup re-emitting an earlier decision keeps it. */
  const founded = (line: string, blockId?: string): boolean =>
    decided ||
    outline.some(
      (e) =>
        DECISION_LABEL.test(e.text) &&
        (blockId !== undefined ? e.id === blockId : sameNote(e.text, line)),
    );

  const out: prose.BlockEdit[] = [];
  /** The new headings this batch opened, so a repeat can join its first. */
  const opened: Array<{
    made: prose.BlockEdit & { markdown: string };
    text: string;
    level: number;
  }> = [];

  const keepLines = (lines: readonly string[], destination: string | undefined): string[] => {
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i] ?? '';
      // A bullet, or a note the model wrote as a bare line: both are notes.
      const bullet = line.match(BULLET);
      const m = bullet ?? line.match(PLAIN_NOTE);
      // A line that is only PART of a block is not a note on its own: a
      // paragraph wrapped across lines, or a bullet whose text runs on at the
      // margin. Judging one line of it would drop that line and leave the rest
      // as a different block, so the whole of it is kept as written.
      if (!m || runsOn(lines, i) || (!bullet && (lines[i - 1] ?? '').trim() !== '')) {
        kept.push(line);
        continue;
      }
      if (DECISION_LABEL.test(line) && !founded(line)) {
        line = line.replace(DECISION_LABEL, '$1');
        notes.push('removed a Decision label the speech did not state');
      }
      const indent = (m[1] ?? '').length;
      if (hasChildren(lines, i, indent)) {
        kept.push(line);
        continue;
      }
      if (written.some((w) => sameNote(w, line))) {
        notes.push('dropped a note this batch already wrote');
        alreadyWritten++;
        continue;
      }
      const twin = existing.find(({ entry }) => sameNote(entry.text, line));
      if (twin && !taken.has(twin.entry.id)) {
        const movable =
          twin.entry.author === ctx.authorId &&
          twin.leaf &&
          destination !== undefined &&
          twin.entry.underHeadingId !== destination &&
          ctx.commented?.().has(twin.entry.id) !== true;
        if (!movable) {
          notes.push(`dropped a note the section already carries (${twin.entry.id})`);
          alreadyWritten++;
          continue;
        }
        taken.add(twin.entry.id);
        out.push({ op: 'delete_block', blockId: twin.entry.id });
        notes.push(`moved a note under its topic (${twin.entry.id})`);
      }
      written.push(line);
      kept.push(line);
    }
    return kept;
  };

  for (const edit of edits) {
    if (edit.op !== 'insert_at_end' && edit.op !== 'insert_under_heading') {
      if (
        edit.op === 'replace_block' &&
        DECISION_LABEL.test(edit.markdown) &&
        !founded(edit.markdown, edit.blockId)
      ) {
        out.push({ ...edit, markdown: edit.markdown.replace(DECISION_LABEL, '$1') });
        notes.push('removed a Decision label the speech did not state');
        continue;
      }
      out.push(edit);
      continue;
    }
    // WHERE THE NOTES LAND, which is what tells a move from a restatement. An
    // insert under the section heading lands at the section's end, under its
    // last topic, exactly as an insert at the end does.
    const atEnd = edit.op === 'insert_at_end' || edit.headingId === headingId;
    // An address that is no heading fails in the applier and is re-homed to
    // the section's end afterwards (`notes-edit-address.ts`), so where it
    // lands is not known here: a restated note under it is dropped, never
    // moved.
    const real = atEnd || headings.has(edit.headingId);
    let target: string | undefined = atEnd ? lastHeading : real ? edit.headingId : undefined;
    // An edit this pass has nothing to say about goes through byte for byte:
    // re-joining its lines is not this module's business, and an edit with
    // no words is the applier's to refuse. One that opened a topic stays
    // rebuilt, because a later edit in the batch may merge into it.
    const mark = notes.length;
    const start = out.length;
    let openedHere = false;
    for (const seg of segmentsOf(edit.markdown)) {
      if (seg.heading === undefined) {
        const lines = keepLines(seg.lines, target);
        if (hasWords(lines)) out.push({ ...edit, markdown: lines.join('\n').trim() });
        continue;
      }
      const key = topicKey(seg.heading.text);
      const known = topics.find((t) => sameTopic(t.text, seg.heading?.text ?? ''));
      if (known && known.level === seg.heading.level) {
        notes.push(`reused the topic heading already in the section (${known.id})`);
        const lines = keepLines(seg.lines, known.id);
        if (hasWords(lines)) {
          out.push({
            op: 'insert_under_heading',
            headingId: known.id,
            markdown: lines.join('\n').trim(),
          });
        }
        continue;
      }
      const opening = `new:${key}`;
      const heading = seg.heading;
      const again = opened.find(
        (o) => o.level === heading.level && sameTopic(o.text, heading.text),
      );
      const lines = keepLines(seg.lines, opening);
      if (atEnd) target = opening;
      if (again) {
        notes.push('merged a topic heading this batch opened twice');
        if (hasWords(lines))
          again.made.markdown = `${again.made.markdown}\n${lines.join('\n').trim()}`;
        continue;
      }
      // A topic whose every note was already in the section is not opened
      // empty: that heading with nothing under it is the other half of what
      // the reader saw.
      if (hasWords(seg.lines) && !hasWords(lines)) {
        notes.push('did not open a topic whose notes were all already written');
        continue;
      }
      const made = {
        ...edit,
        markdown:
          `${'#'.repeat(seg.heading.level)} ${seg.heading.text}\n\n${lines.join('\n').trim()}`.trim(),
      };
      if (key.length > 0) {
        opened.push({ made, text: heading.text, level: heading.level });
        openedHere = true;
      }
      out.push(made);
    }
    if (notes.length === mark && !openedHere) {
      out.length = start;
      out.push(edit);
    }
  }
  return { edits: out, notes, alreadyWritten };
}
