/**
 * Paraphrased repeats: a note that says again, in other words, what earlier
 * notes under the same heading already say.
 *
 * WHY A MODEL. `repeatedBullets` (`notes-quality-report.ts`) catches a bullet
 * written twice in the same words, and since PR 1395 a replay finds none. A
 * reader still finds five to ten restated notes a meeting, because the second
 * copy is worded differently and no word test can tell "the export is done"
 * from "the export finished" while also telling it from "the export is late".
 *
 * ONLY WITHIN A SECTION. That is where a reader meets the second copy, and it
 * keeps each question small.
 *
 * TWO STAGES, because neither model was both thorough and right alone. On the
 * hand-labelled meeting (task report), Sonnet asked for a verdict on every
 * note found five or six of the six repeats a person found, and named about
 * twice as many again that were not repeats. Opus asked the same way named
 * only true repeats, and only two or three of the six. So Sonnet PROPOSES,
 * one call per ~60 notes, and Opus CHECKS each proposal alone against the
 * notes above it. Together they found five of six with nothing false, on
 * two runs each.
 *
 * THE COUNT is of restating notes: a note that restates two earlier ones is
 * one extra line for the reader. A batch the proposer would not answer twice
 * is left out of `judgedNotes`, and a proposal the checker would not answer
 * is counted in `unchecked`, never as a repeat.
 */

import { type SummaryCredential, authHeader } from '../packages/server/src/summarize.ts';

export interface NoteSection {
  heading: string;
  notes: string[];
}

export interface RepeatPair {
  /** Index into the batch's sections, then into that section's notes. */
  section: number;
  note: number;
  restates: number;
}

export interface RepeatCount {
  /** Every note in the doc. */
  notes: number;
  /** Notes in sections the judge answered for, plus sections of one note. */
  judgedNotes: number;
  /** Notes that restate an earlier one. */
  repeats: number;
  /** Proposals the checker could not be read on. */
  unchecked: number;
  pairs: Array<{ heading: string; note: number; restates: number }>;
}

/** One model call: the user message in, the tool's input out, or null. */
export type RepeatCall = (user: string) => Promise<unknown>;

const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
/** `[@Name](speaker:...)` reads as `Name`: who said it can matter. */
const SPEAKER_TAG = /\[@([^\]]+)\]\(speaker:[^)]*\)/g;

/** The notes cut at every heading; a bullet before any heading is under "". */
export function noteSections(notes: string): NoteSection[] {
  const out: NoteSection[] = [];
  let cur: NoteSection | null = null;
  for (const line of notes.split('\n')) {
    const h = HEADING.exec(line);
    if (h) {
      cur = { heading: (h[1] ?? '').trim(), notes: [] };
      out.push(cur);
      continue;
    }
    const b = BULLET.exec(line);
    if (!b) continue;
    const text = (b[1] ?? '').replace(SPEAKER_TAG, '$1').trim();
    if (!text) continue;
    if (!cur) {
      cur = { heading: '', notes: [] };
      out.push(cur);
    }
    cur.notes.push(text);
  }
  return out.filter((s) => s.notes.length > 0);
}

/** Sections of two or more notes, packed whole into batches of at most
 *  `maxNotes` (a bigger section is a batch of its own). */
export function repeatBatches(sections: readonly NoteSection[], maxNotes = 60): NoteSection[][] {
  const out: NoteSection[][] = [];
  let cur: NoteSection[] = [];
  let n = 0;
  for (const s of sections) {
    if (s.notes.length < 2) continue;
    if (cur.length > 0 && n + s.notes.length > maxNotes) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(s);
    n += s.notes.length;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export const PROPOSE_MODEL = 'claude-sonnet-5-5';
export const CHECK_MODEL = 'claude-opus-5-5';

export const PROPOSE_SYSTEM = [
  'You check meeting notes for repeats. The notes come in numbered sections,',
  'one per heading, and each note in a section is numbered.',
  '',
  'For EVERY note after the first in each section, decide whether it RESTATES',
  'the earlier notes in that section: a reader who has just read them would',
  'learn nothing at all from this note. It says again, in other words, what',
  'one earlier note says, or what several earlier notes say together.',
  '',
  'Most notes in a section are about the same topic and are NOT restatements.',
  'A note is new when it says even one thing no earlier note in the section',
  'says: a fact, a reason, a number, a date, an owner, a next step, a detail,',
  'a consequence, or a different person answering, agreeing or confirming.',
  'When in doubt, it is new.',
  '',
  'Answer with the record_repeats tool: one row per note after the first, with',
  '`restates` the number of the earlier note it repeats, or 0 if it is new.',
].join('\n');

export const PROPOSE_TOOL = {
  name: 'record_repeats',
  description: 'Say, per note, which earlier note in its section it restates, or 0.',
  input_schema: {
    type: 'object' as const,
    properties: {
      repeats: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            section: { type: 'number' },
            note: { type: 'number' },
            restates: { type: 'number' },
          },
          required: ['section', 'note', 'restates'],
        },
      },
    },
    required: ['repeats'],
  },
};

export const CHECK_SYSTEM = [
  'You check one note in a set of meeting notes. You get the earlier notes',
  'under its heading, and then the note to check.',
  '',
  'Decide whether the note to check is a REPEAT: a reader who has just read',
  'the earlier notes would learn nothing from it, because one earlier note, or',
  'several together, already say everything it says. Other words do not make',
  'it new.',
  '',
  'It is NOT a repeat when it says even one thing the earlier notes do not: a',
  'fact, a reason, a number, a date, an owner, a next step, a detail, or a',
  'different person answering, agreeing or confirming.',
  '',
  'Answer with the record_verdict tool.',
].join('\n');

export const CHECK_TOOL = {
  name: 'record_verdict',
  description: 'Say whether the note is a repeat.',
  input_schema: {
    type: 'object' as const,
    properties: { repeat: { type: 'boolean' } },
    required: ['repeat'],
  },
};

/** The checker's question about one proposal. */
export function checkPrompt(section: NoteSection, note: number): string {
  const earlier = section.notes
    .slice(0, note)
    .map((n, i) => `  ${i + 1}. ${n}`)
    .join('\n');
  return `Heading: ${section.heading || '(no heading)'}\nEarlier notes:\n${earlier}\n\nNote to check:\n  ${section.notes[note] ?? ''}`;
}

export function repeatPrompt(batch: readonly NoteSection[]): string {
  return batch
    .map(
      (s, i) =>
        `Section ${i + 1}: ${s.heading || '(no heading)'}\n${s.notes.map((n, j) => `  ${j + 1}. ${n}`).join('\n')}`,
    )
    .join('\n\n');
}

/** A list the model wrote as a JSON string, sometimes wrapped in its own
 *  `{repeats}`, read as the list. */
function unnest(rows: unknown): unknown {
  if (typeof rows !== 'string') return rows;
  try {
    const parsed = JSON.parse(rows) as unknown;
    return Array.isArray(parsed) ? parsed : (parsed as { repeats?: unknown } | null)?.repeats;
  } catch {
    return null;
  }
}

/**
 * The judge's pairs as 0-based indices, the later note first, each restating
 * note once. Null when the answer is not one: a section or note the batch
 * never had, or a note said to restate itself, means the judge lost its place.
 */
export function parseRepeatAnswer(
  input: unknown,
  batch: readonly NoteSection[],
): RepeatPair[] | null {
  const rows = unnest((input as { repeats?: unknown } | null)?.repeats);
  if (!Array.isArray(rows)) return null;
  const seen = new Set<string>();
  const out: RepeatPair[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    // 0 is the judge's "says something new".
    if (Number(row?.restates) === 0) continue;
    const s = Number(row?.section) - 1;
    const a = Number(row?.note) - 1;
    const b = Number(row?.restates) - 1;
    const len = batch[s]?.notes.length ?? 0;
    if (![s, a, b].every(Number.isInteger) || a < 0 || b < 0 || a >= len || b >= len || a === b) {
      return null;
    }
    const pair = { section: s, note: Math.max(a, b), restates: Math.min(a, b) };
    const key = `${s}:${pair.note}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
  }
  return out;
}

/** Count the restating notes in `notes`: each batch proposed (asked twice
 *  before it is left unjudged), each proposal checked (asked twice before it
 *  is left unchecked). */
export async function judgeRepeats(
  notes: string,
  propose: RepeatCall,
  check: RepeatCall,
  maxNotes = 60,
): Promise<RepeatCount> {
  const sections = noteSections(notes);
  const total = sections.reduce((n, s) => n + s.notes.length, 0);
  let unjudged = 0;
  let unchecked = 0;
  const pairs: RepeatCount['pairs'] = [];
  for (const batch of repeatBatches(sections, maxNotes)) {
    const user = repeatPrompt(batch);
    let found = parseRepeatAnswer(await propose(user), batch);
    if (found === null) found = parseRepeatAnswer(await propose(user), batch);
    if (found === null) {
      unjudged += batch.reduce((n, s) => n + s.notes.length, 0);
      continue;
    }
    for (const p of found) {
      const section = batch[p.section] as NoteSection;
      const ask = checkPrompt(section, p.note);
      let verdict = readVerdict(await check(ask));
      if (verdict === null) verdict = readVerdict(await check(ask));
      if (verdict === null) unchecked++;
      if (verdict !== true) continue;
      pairs.push({ heading: section.heading, note: p.note, restates: p.restates });
    }
  }
  return { notes: total, judgedNotes: total - unjudged, repeats: pairs.length, unchecked, pairs };
}

function readVerdict(input: unknown): boolean | null {
  const v = (input as { repeat?: unknown } | null)?.repeat;
  return typeof v === 'boolean' ? v : null;
}

/**
 * A `RepeatCall` on the Messages API. These models refuse a forced
 * `tool_choice`, so the tool is offered and the reply's tool call read; a
 * reply that makes none is null. The status is reported, never the body: a
 * body can echo the notes.
 */
export function modelCall(opts: {
  key: SummaryCredential;
  model: string;
  system: string;
  tool: { name: string };
  maxTokens: number;
  /** Sent before each user message behind a cache mark, when given. */
  cached?: string;
  /** Books one reply's `usage` block, as `SpendMeter.book` does. */
  book: (model: string, usage: Record<string, unknown> | undefined) => void;
  fetchImpl?: typeof fetch;
}): RepeatCall {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async (user) => {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeader(opts.key),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        tools: [opts.tool],
        tool_choice: { type: 'auto' },
        output_config: { effort: opts.model === CHECK_MODEL ? 'low' : 'medium' },
        messages: [
          {
            role: 'user',
            content:
              opts.cached === undefined
                ? user
                : [
                    { type: 'text', text: opts.cached, cache_control: { type: 'ephemeral' } },
                    { type: 'text', text: user },
                  ],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`  repeat call returned HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as {
      content?: Array<{ type?: string; name?: string; input?: unknown }>;
      usage?: Record<string, unknown>;
    };
    opts.book(opts.model, body.usage);
    return (
      body.content?.find((b) => b.type === 'tool_use' && b.name === opts.tool.name)?.input ?? null
    );
  };
}
