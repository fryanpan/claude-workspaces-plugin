/**
 * The shape of a meeting's recap, enforced by code once the note-taker has
 * had its last word.
 *
 * WHY THIS EXISTS. Bryan's feedback on one real recap
 * named five defects, and four of them are structure a model is asked for
 * and does not reliably give:
 *
 * - Headings follow the order points arrived in, so a point made late about
 *   an earlier subject lands under whatever heading was open at the time.
 * - A point appears twice.
 * - Two separate points are joined by a "because" the speaker never said.
 * - Bullets nest five deep, and decisions and follow-ups are buried in them.
 *
 * Each of those can be decided from the notes and the transcript alone, so
 * this module decides it rather than asking again. It is pure: markdown and
 * the spoken sentences in, markdown out. `notes-recap-apply.ts` writes the
 * answer into the doc at the meeting's stop.
 *
 * WHAT IT WILL NOT SHAPE. A section holding anything but headings and
 * bullets — a numbered list (the dictated-layout rule says its order is the
 * point), a paragraph, a table, code — returns `null`, and the caller leaves
 * it alone. The rules below are lexical, so each errs toward leaving a note
 * where it is: a point moves only when its own heading shares no word with it
 * and exactly one other heading does.
 */

import { contentWords, negates } from '@claude-workspaces/core';
import { coveredBy, noteKey, sameNote } from './notes-edit-dedupe.ts';
import { topicKey } from './notes-quality.ts';

/** The heading the decisions and follow-ups are gathered under, first in the recap. */
export const RECAP_ACTIONS_HEADING = 'Decisions and follow-ups';

/** A bullet and, at most, one level of bullets under it. */
interface Point {
  text: string;
  children: string[];
}

interface Topic {
  level: number;
  heading: string;
  points: Point[];
}

export interface RecapShapeCounts {
  /** Points moved under the heading of their subject. */
  moved: number;
  /** Headings opened for a subject the notes had changed to without one. */
  opened: number;
  /** Near-duplicate points folded into the fuller copy. */
  merged: number;
  /** Points split where a cause was joined that nobody stated. */
  split: number;
  /** Bullets lifted from below the second level. */
  flattened: number;
  /** Decisions and follow-ups gathered into the section at the top. */
  gathered: number;
}

export interface RecapShape {
  markdown: string;
  changed: boolean;
  counts: RecapShapeCounts;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+/;
const SPEAKER_TAG = /\[@[^\]]*\]\(speaker:[^)]*\)\s*/g;

/** A label the note-taker writes on a decision. */
const DECISION_LABEL = /^(?:\*\*|__)?\s*(?:decision|decided)\s*:/i;
/** A label on a follow-up, or a named owner who "will" do something. */
const FOLLOW_UP_LABEL = /^(?:\*\*|__)?\s*(?:follow[- ]?up|action(?: item)?|next step|to ?do)\s*:/i;
const OWNER_WILL =
  /^(?:I|We|[A-Z][\w'-]*)(?:\s+and\s+[A-Z][\w'-]*)?\s+(?:will|'ll|is going to|are going to)\s+\w/;

/** A cause joining two clauses. "Since" and "due to" are left out: both are
 *  as often about time or a date as about a reason. */
const CAUSE =
  /,?\s+\b(because|so that|which is why|that is why|therefore|as a result)\b,?\s+|,\s+so\s+/i;
/** What a spoken sentence says when it states a reason. */
const SPOKEN_CAUSE = /\b(because|cause|so|why|therefore|reason|result|since|due)\b/i;

function bare(text: string): string {
  return text.replace(SPEAKER_TAG, '').trim();
}

function actionKind(text: string): 'decision' | 'follow-up' | undefined {
  const b = bare(text);
  if (DECISION_LABEL.test(b)) return 'decision';
  if (FOLLOW_UP_LABEL.test(b) || OWNER_WILL.test(b)) return 'follow-up';
  return undefined;
}

function words(text: string): Set<string> {
  return new Set(contentWords(noteKey(text)));
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/** Parse the section into topics, or `null` when it holds something this
 *  module does not shape. */
function parse(markdown: string): { topics: Topic[]; flattened: number } | null {
  const topics: Topic[] = [];
  let flattened = 0;
  for (const line of markdown.split('\n')) {
    if (line.trim().length === 0) continue;
    const h = line.match(HEADING);
    if (h) {
      topics.push({ level: (h[1] ?? '#').length, heading: (h[2] ?? '').trim(), points: [] });
      continue;
    }
    const b = line.match(BULLET);
    const topic = topics[topics.length - 1];
    if (!b || ORDERED.test(line) || !topic) return null;
    const depth = Math.floor((b[1] ?? '').replace(/\t/g, '  ').length / 2);
    const text = (b[2] ?? '').trim();
    const last = topic.points[topic.points.length - 1];
    if (depth === 0 || !last) topic.points.push({ text, children: [] });
    else {
      if (depth > 1) flattened++;
      last.children.push(text);
    }
  }
  return { topics, flattened };
}

function render(actionsLevel: number, actions: Point[], topics: readonly Topic[]): string {
  const blocks: string[] = [];
  const block = (level: number, heading: string, points: readonly Point[]): void => {
    const lines = [`${'#'.repeat(level)} ${heading}`, ''];
    for (const p of points) {
      lines.push(`- ${p.text}`);
      for (const c of p.children) lines.push(`  - ${c}`);
    }
    blocks.push(lines.join('\n'));
  };
  if (actions.length > 0) block(actionsLevel, RECAP_ACTIONS_HEADING, actions);
  for (const t of topics) if (t.points.length > 0) block(t.level, t.heading, t.points);
  return `${blocks.join('\n\n')}\n`;
}

/** Split `text` at a cause no spoken sentence states, or return it whole. */
function splitUnstatedCause(text: string, spoken: readonly string[]): string[] {
  const m = text.match(CAUSE);
  if (!m || m.index === undefined) return [text];
  const before = text.slice(0, m.index).trim();
  const after = text.slice(m.index + m[0].length).trim();
  if (before.length === 0 || after.length === 0) return [text];
  const wb = words(before);
  const wa = words(after);
  const stated = spoken.some((s) => {
    if (!SPOKEN_CAUSE.test(s)) return false;
    const ws = new Set(contentWords(s));
    return overlap(wb, ws) > 0 && overlap(wa, ws) > 0;
  });
  if (stated) return [text];
  return [before, after.charAt(0).toUpperCase() + after.slice(1)];
}

/** Whether `a` and `b` say one thing, and which of them says more. */
function duplicate(a: string, b: string): boolean {
  if (negates(a) !== negates(b)) return false;
  return sameNote(a, b) || coveredBy(a, b) || coveredBy(b, a);
}

function fuller(a: string, b: string): string {
  return words(b).size > words(a).size ? b : a;
}

const isQuestions = (t: Topic): boolean => topicKey(t.heading) === 'open questions';

/**
 * Shape a meeting's notes section. `spoken` is the meeting's settled turns
 * (or their sentences), read only to decide whether a cause was stated.
 */
export function shapeRecap(markdown: string, spoken: readonly string[]): RecapShape | null {
  const parsed = parse(markdown);
  if (!parsed || parsed.topics.length === 0) return null;
  const counts: RecapShapeCounts = {
    moved: 0,
    opened: 0,
    merged: 0,
    split: 0,
    flattened: parsed.flattened,
    gathered: 0,
  };
  const sentences = spoken.flatMap((s) => s.split(/(?<=[.!?])\s+/));
  const actionsLevel = parsed.topics[0]?.level ?? 3;
  let topics = parsed.topics.filter((t) => topicKey(t.heading) !== topicKey(RECAP_ACTIONS_HEADING));
  const decisions: Point[] = [];
  const followUps: Point[] = [];
  for (const t of parsed.topics) {
    if (topicKey(t.heading) !== topicKey(RECAP_ACTIONS_HEADING)) continue;
    for (const p of t.points) (actionKind(p.text) === 'decision' ? decisions : followUps).push(p);
  }

  // Decisions and follow-ups out of the topics, wherever they were nested.
  for (const t of topics) {
    const kept: Point[] = [];
    for (const p of t.points) {
      const kind = actionKind(p.text);
      if (kind !== undefined) {
        (kind === 'decision' ? decisions : followUps).push(p);
        counts.gathered++;
        continue;
      }
      const children: string[] = [];
      for (const c of p.children) {
        const ck = actionKind(c);
        if (ck === undefined) children.push(c);
        else {
          (ck === 'decision' ? decisions : followUps).push({ text: c, children: [] });
          counts.gathered++;
        }
      }
      kept.push({ text: p.text, children });
    }
    t.points = kept;
  }

  // A cause nobody stated comes apart into the two points it joined.
  const unjoin = (points: Point[]): Point[] =>
    points.flatMap((p) => {
      const parts = splitUnstatedCause(p.text, sentences);
      if (parts.length === 1) return [p];
      counts.split++;
      return parts.map((text, i) => ({ text, children: i === 0 ? p.children : [] }));
    });
  // Only with a transcript to read: with none, every cause is unstated and a
  // split would be a guess about speech this pass never saw.
  if (sentences.length > 0) for (const t of topics) t.points = unjoin(t.points);

  // Each point once across the whole recap; the fuller wording stays, in the
  // place the first copy held.
  const seen: Point[] = [];
  const dedupe = (points: Point[]): Point[] =>
    points.filter((p) => {
      const twin = seen.find((s) => duplicate(s.text, p.text));
      if (!twin) {
        seen.push(p);
        return true;
      }
      twin.text = fuller(twin.text, p.text);
      for (const c of p.children)
        if (!twin.children.some((x) => duplicate(x, c))) twin.children.push(c);
      counts.merged++;
      return false;
    });
  const actions = [...dedupe(decisions), ...dedupe(followUps)];
  for (const t of topics) t.points = dedupe(t.points);

  // A late point goes under the heading of its subject: its own heading and
  // its neighbours share no word with it, and exactly one other heading does.
  const subjects = topics.filter((t) => !isQuestions(t));
  for (const t of subjects) {
    const keep: Point[] = [];
    for (const p of t.points) {
      const w = words(p.text);
      const own = overlap(w, words(t.heading));
      const kin = t.points.some((q) => q !== p && overlap(w, words(q.text)) > 0);
      const scores = subjects.map((o) => (o === t ? 0 : overlap(w, words(o.heading))));
      const best = Math.max(0, ...scores);
      const home = best > 0 && scores.filter((s) => s === best).length === 1;
      if (own === 0 && !kin && home) {
        subjects[scores.indexOf(best)]?.points.push(p);
        counts.moved++;
      } else keep.push(p);
    }
    t.points = keep;
  }

  // A subject the notes changed to without a heading: a trailing run of two
  // or more points that share words with each other and none with the
  // heading or the points above them.
  const out: Topic[] = [];
  for (const t of topics) {
    out.push(t);
    if (isQuestions(t)) continue;
    const opened = trailingSubject(t);
    if (!opened) continue;
    t.points = t.points.slice(0, t.points.length - opened.points.length);
    out.push(opened);
    counts.opened++;
  }
  topics = out;

  // Changed means a rule fired, not that the text differs: the doc's own
  // serialization spaces a section differently from `render`, and rewriting
  // a section only to re-space it would re-create every block for nothing.
  const changed = Object.values(counts).some((n) => n > 0);
  return { markdown: render(actionsLevel, actions, topics), changed, counts };
}

/** The run at the end of `t` that is about a subject of its own, headed. */
function trailingSubject(t: Topic): Topic | undefined {
  const heading = words(t.heading);
  let start = t.points.length;
  while (start > 0 && overlap(words((t.points[start - 1] as Point).text), heading) === 0) start--;
  for (let from = start; from <= t.points.length - 2; from++) {
    if (from === 0) continue;
    const run = t.points.slice(from);
    const above = t.points.slice(0, from).map((p) => words(p.text));
    let common = words((run[0] as Point).text);
    for (const p of run.slice(1)) {
      const w = words(p.text);
      common = new Set([...common].filter((x) => w.has(x)));
    }
    if (common.size === 0) continue;
    if (run.some((p) => above.some((a) => overlap(words(p.text), a) > 0))) continue;
    const surface = bare((run[0] as Point).text)
      .split(/[^\p{L}\p{N}'-]+/u)
      .filter((tok, i, all) => {
        const stem = contentWords(tok)[0];
        return stem !== undefined && common.has(stem) && all.indexOf(tok) === i;
      });
    if (surface.length === 0) continue;
    const name = surface.join(' ');
    return {
      level: t.level,
      heading: name.charAt(0).toUpperCase() + name.slice(1),
      points: run,
    };
  }
  return undefined;
}
