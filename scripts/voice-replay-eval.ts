#!/usr/bin/env bun
/**
 * Does a recording's feedback come out as one comment per topic — none
 * repeated, none lost?
 *
 * `voice-pick-eval.ts` scores single ticks. This replays whole recordings:
 * the turns a staging recording's engine settled, fed one by one through the
 * real relay (mock engine, real model), so every tick sees the open comment
 * the tick before it left. The turns are copied from staging recordings of a
 * status page, in each of the forms the engine wrote them; the first of them
 * is the one whose Saltmarsh comment came back ending "And the save button
 * should say save changes." beside a Save comment saying it again.
 *
 * Each recording is scored on the comments it settled: a topic in more than
 * one comment is a REPEAT, a topic in none is LOST. "model" is the same count
 * over the model's own replies, before the relay's apportioning — what the
 * person would have seen without it.
 *
 * It spends the EVAL credential only (`eval-credential.ts`). Three short
 * calls per recording: under half a cent each.
 *
 *   bun run scripts/voice-replay-eval.ts [--runs 7]
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { withoutProdMarker } from '../packages/server/src/claude-key-source.ts';
import { createMockTranscriptionEngine } from '../packages/server/src/transcribe.ts';
import { VoiceFeedbackRelay, type VoiceWs } from '../packages/server/src/voice-feedback-relay.ts';
import {
  TIDY_MODEL,
  type TidyComplete,
  createHaikuTidy,
  parseTidyReply,
  tidyDollars,
} from '../packages/server/src/voice-feedback-tidy.ts';
import { EVAL_CREDENTIAL_HELP } from './eval-credential.ts';

const window = new Window();
Object.assign(globalThis, { HTMLElement: window.HTMLElement, Element: window.Element });
const { collectTargets } = await import('../packages/widget/src/voice/voice-targets.ts');
window.document.body.innerHTML = readFileSync(
  join(import.meta.dir, 'fixtures/voice-pick/riverbend-status.html'),
  'utf8',
);
const { targets } = collectTargets(window.document.body as unknown as ParentNode, () => true);

const LAUNCH =
  'The harbor light launch date should move to October. It is too early for the ferry schedule.';
const RECORDINGS: string[][] = [
  [
    LAUNCH,
    'The salt marsh budget card needs the total at the top, not at the bottom.',
    'And the save button should say save changes.',
  ],
  [
    LAUNCH,
    'The salt-marsh budget card needs the total at the top, not at the bottom.',
    'And the save button should say "Save changes."',
  ],
  [
    LAUNCH,
    'The salt marsh budget card needs the total at the top, not at the bottom.',
    'And the save button should say "Save changes."',
  ],
];
const TOPICS = [/october|ferry/i, /total|bottom/i, /save changes/i];

/** How each topic fared across a recording's comments. */
function score(texts: string[]): { repeat: boolean; lost: boolean } {
  const counts = TOPICS.map((re) => texts.filter((t) => re.test(t)).length);
  return { repeat: counts.some((n) => n > 1), lost: counts.some((n) => n === 0) };
}

const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 1;
const complete = createHaikuTidy({ env: withoutProdMarker(process.env) });
if (!complete) {
  console.error(EVAL_CREDENTIAL_HELP);
  process.exit(2);
}

const poll = async (probe: () => boolean): Promise<void> => {
  for (let i = 0; i < 600 && !probe(); i++) await new Promise((r) => setTimeout(r, 50));
  if (!probe()) throw new Error('replay: timed out waiting on the relay');
};

async function replay(
  turns: string[],
): Promise<{ settled: string[]; model: string[]; usd: number }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-replay-'));
  let done = 0;
  let usd = 0;
  // The model's own comments, folded the way the relay places them.
  const model: string[] = [];
  const tidy: TidyComplete = async (req) => {
    const reply = await (complete as TidyComplete)(req);
    usd += tidyDollars(reply.usage);
    const open = req.user.includes('<open>none</open>')
      ? null
      : { text: '', raw: '', target: null, fixed: false };
    for (const c of parseTidyReply(reply.text, { targets, open, words: '' }) ?? []) {
      if (c.continues && model.length > 0) model[model.length - 1] = c.text;
      else model.push(c.text);
    }
    done++;
    return reply;
  };
  const relay = new VoiceFeedbackRelay({
    engines: [createMockTranscriptionEngine(turns.map((t) => ({ words: t.split(' ') })))],
    tidy,
    dataDir,
    pauseMs: 5,
  });
  const frames: Array<{ type: string; key?: string; text?: string }> = [];
  const ws: VoiceWs = {
    data: { docId: 'riverbend-status', workspaceId: 'riverbend' },
    send: (p) => frames.push(JSON.parse(p)),
    close: () => {},
  };
  try {
    relay.onText(ws, JSON.stringify({ type: 'start', sampleRate: 16_000, targets }));
    await poll(() => frames.some((f) => f.type === 'ready'));
    for (const [k, turn] of turns.entries()) {
      // One word a chunk, and one more chunk settles the turn.
      for (let i = 0; i <= turn.split(' ').length; i++) relay.onAudio(ws, new Uint8Array(640));
      await poll(() => done > k);
    }
    relay.onText(ws, JSON.stringify({ type: 'stop' }));
    await poll(() => frames.some((f) => f.type === 'stopped'));
  } finally {
    await relay.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
  const last = new Map<string, string>();
  for (const f of frames) if (f.type === 'comment' && f.key) last.set(f.key, f.text ?? '');
  return { settled: [...last.values()], model, usd };
}

let n = 0;
let repeats = 0;
let lost = 0;
let modelRepeats = 0;
let modelLost = 0;
let usd = 0;
console.log(`catalog: ${targets.length} targets; model ${TIDY_MODEL}; runs ${runs}`);
for (let r = 0; r < runs; r++) {
  for (const [k, turns] of RECORDINGS.entries()) {
    const out = await replay(turns);
    usd += out.usd;
    const s = score(out.settled);
    const m = score(out.model);
    n++;
    if (s.repeat) repeats++;
    if (s.lost) lost++;
    if (m.repeat) modelRepeats++;
    if (m.lost) modelLost++;
    const verdict = s.repeat ? 'REPEAT' : s.lost ? 'LOST' : 'PASS';
    console.log(`${verdict}  recording ${k + 1}: ${out.settled.map((t) => `"${t}"`).join(' | ')}`);
    if (m.repeat && !s.repeat) console.log('        model repeated; the relay took it out');
  }
}
console.log(
  `\nrecordings ${n}  repeat ${repeats}/${n} (model ${modelRepeats}/${n})  ` +
    `lost ${lost}/${n} (model ${modelLost}/${n})  spend $${usd.toFixed(4)}`,
);
