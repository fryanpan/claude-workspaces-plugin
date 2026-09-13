#!/usr/bin/env bun
/**
 * Does the transcriber pick the element a person is talking about?
 *
 * The riskiest half of voice feedback is not the transcription — that is the
 * meeting path's, and measured there — it is turning "the goal bar just says
 * sixty six percent" into the goal element, and telling "and it should name
 * the next task" (same comment) from "and blocked is the same grey as done"
 * (new comment, different element). This runs the real catalog builder over a
 * fixture page and the real prompt against the model, and scores both calls.
 *
 * It spends the EVAL credential only (`eval-credential.ts`). About 14 short
 * calls per run: well under ten cents.
 *
 *   bun run scripts/voice-pick-eval.ts [--runs 2]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { withoutProdMarker } from '../packages/server/src/claude-key-source.ts';
import {
  TIDY_MODEL,
  type TidyInput,
  buildTidyPrompt,
  createHaikuTidy,
  parseTidyReply,
  splitTick,
  tidyDollars,
} from '../packages/server/src/voice-feedback-tidy.ts';
import { EVAL_CREDENTIAL_HELP } from './eval-credential.ts';

const window = new Window();
Object.assign(globalThis, { HTMLElement: window.HTMLElement, Element: window.Element });
const { collectTargets } = await import('../packages/widget/src/voice/voice-targets.ts');

const html = readFileSync(
  join(import.meta.dir, 'fixtures/voice-pick/riverbend-board.html'),
  'utf8',
);
window.document.body.innerHTML = html;
const doc = window.document;
const { targets, elements } = collectTargets(doc.body as unknown as ParentNode, () => true);
const idx = (sel: string): number => {
  const el = doc.querySelector(sel);
  const i = [...elements].find(([, e]) => e === (el as unknown as HTMLElement))?.[0] ?? -1;
  if (i < 0) throw new Error(`fixture: ${sel} is not in the catalog`);
  return i;
};

interface Case {
  name: string;
  open?: { text: string; at: string | null; fixed?: boolean };
  pinned?: string | null;
  words: string;
  /** Acceptable targets for the LAST comment returned; null = the page. */
  expect: string[] | null | 'none';
  /** Whether the first comment should continue the open one. */
  continues?: boolean;
  /** For a reply of two comments: how the second one's raw words must begin (filler aside). */
  splitAt?: RegExp;
}

const GOAL_OPEN = {
  text: 'The goal bar shows a percentage but not what is left to do.',
  at: '#goal',
};

const CASES: Case[] = [
  {
    name: 'names the goal bar',
    words: "the goal bar just says sixty six percent it doesn't tell me what's left to do",
    expect: ['#goal', '.bar', '.meta'],
    continues: false,
  },
  {
    name: 'same topic grows',
    open: GOAL_OPEN,
    words: 'and it should name the next task I need to finish',
    expect: ['#goal', '.bar', '.meta'],
    continues: true,
  },
  {
    name: 'new topic, a chip',
    open: GOAL_OPEN,
    words: "and blocked is the same grey as done I can't spot it",
    expect: ['#blk'],
    continues: false,
  },
  {
    name: 'the add button',
    words: 'the add task button is way too faint it looks disabled',
    expect: ['#add'],
  },
  {
    name: 'a task title',
    words: 'the share a pantry list by link task title is long and wraps on my phone',
    expect: ['#t-share', '#t-share .t'],
  },
  {
    name: 'the page in general',
    words: 'overall this whole page feels cramped there is no breathing room anywhere',
    expect: null,
  },
  {
    name: 'filler only',
    words: 'um okay let me see',
    expect: 'none',
  },
  {
    name: 'the avatar',
    words: 'the little initials circle in the top right should open an account menu',
    expect: ['.who'],
  },
  {
    name: 'running chip colour',
    words: 'the running chip should be green not blue',
    expect: ['#running'],
  },
  {
    name: 'breadcrumb',
    words:
      "the breadcrumb that says board launch the pantry sync repeats the goal name it's redundant",
    expect: ['.crumb'],
  },
  {
    name: 'disambiguates two done chips',
    words: 'the done chip on the pantry import task is wrong quantities still get lost',
    expect: ['#done2', '#t-import', '#t-import .t'],
  },
  {
    name: 'continue then change topic',
    open: { text: 'The Add task button looks disabled.', at: '#add' },
    words:
      'yeah make it a solid button actually also the sync resumes task says blocked but nobody said why',
    expect: ['#blk', '#t-sleep', '#t-sleep .t'],
    continues: true,
    splitAt: /^(actually )?(also )?the sync resumes/,
  },
  {
    name: 'fixed element is kept',
    open: { text: 'This should be clearer.', at: '#blk', fixed: true },
    words: 'it needs a reason next to it saying what it is waiting on',
    expect: ['#blk'],
    continues: true,
  },
  {
    name: 'pinned element takes the next words',
    pinned: '#add',
    words: 'this should ask which goal the new task belongs to',
    expect: ['#add'],
    continues: false,
  },
];

const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 1;
const complete = createHaikuTidy({ env: withoutProdMarker(process.env) });
if (!complete) {
  console.error(EVAL_CREDENTIAL_HELP);
  process.exit(2);
}

let pickOk = 0;
let pickN = 0;
let topicOk = 0;
let topicN = 0;
let splitOk = 0;
let splitN = 0;
let usd = 0;
const lat: number[] = [];
console.log(`catalog: ${targets.length} targets; model ${TIDY_MODEL}; runs ${runs}`);
for (let r = 0; r < runs; r++) {
  for (const c of CASES) {
    const input: TidyInput = {
      targets,
      open: c.open
        ? {
            text: c.open.text,
            target: c.open.at === null ? null : idx(c.open.at),
            fixed: c.open.fixed === true,
          }
        : null,
      ...(c.pinned !== undefined ? { pinned: c.pinned === null ? null : idx(c.pinned) } : {}),
      words: c.words,
    };
    const t0 = performance.now();
    const reply = await complete(buildTidyPrompt(input));
    lat.push(performance.now() - t0);
    usd += tidyDollars(reply.usage);
    const comments = parseTidyReply(reply.text, input) ?? [];
    const last = comments.at(-1);
    let pick: boolean;
    if (c.expect === 'none') pick = comments.length === 0;
    else if (c.expect === null) pick = !!last && last.target === null;
    else {
      const ok = new Set(c.expect.map(idx));
      pick = !!last && last.target !== null && ok.has(last.target);
    }
    pickN++;
    if (pick) pickOk++;
    let topic = true;
    if (c.continues !== undefined) {
      topicN++;
      topic = !!comments[0] && comments[0].continues === c.continues;
      if (c.name === 'continue then change topic') topic = topic && comments.length >= 2;
      if (topic) topicOk++;
    }
    let split = true;
    if (c.splitAt) {
      splitN++;
      const parts = splitTick(c.words, comments, 0, 1);
      split = parts.length >= 2 && c.splitAt.test(parts[1]?.words ?? '');
      if (split) splitOk++;
    }
    const got = comments
      .map(
        (x) =>
          `${x.continues ? '+' : '*'}${x.target === null ? 'page' : `e${x.target}`} "${x.text}"`,
      )
      .join(' | ');
    console.log(
      `${pick && topic && split ? 'PASS' : 'FAIL'}  ${c.name}: ${got || '(no comments)'}`,
    );
  }
}
lat.sort((a, b) => a - b);
console.log(
  `\npick ${pickOk}/${pickN}  topic ${topicOk}/${topicN}  split ${splitOk}/${splitN}  ` +
    `latency p50 ${Math.round(lat[Math.floor(lat.length / 2)] ?? 0)}ms ` +
    `p90 ${Math.round(lat[Math.floor(lat.length * 0.9)] ?? 0)}ms  spend $${usd.toFixed(4)} ` +
    `($${(usd / pickN).toFixed(5)} per tick)`,
);
