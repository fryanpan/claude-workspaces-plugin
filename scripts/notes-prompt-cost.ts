/**
 * What one notes tick's prompt costs, measured rather than estimated.
 *
 * The notes compose is the expensive half of a meeting — the capture pass is
 * priced by `intent-prompt-cost.ts`, and this is its sibling for the other
 * call. The instructions are a settings file an operator may rewrite, and
 * every word of them is paid on EVERY tick of every meeting, so "how much did
 * that wording cost" is a question somebody will ask again.
 *
 *   bun run scripts/notes-prompt-cost.ts
 *   bun run scripts/notes-prompt-cost.ts --baseline <file>   # compare
 *
 * `--baseline` takes a plain text file holding another set of instructions —
 * the previous release's, pulled out with `git show` — and prints the delta.
 * Nothing else about the prompt changes between the two runs, so the
 * difference is the instructions and nothing else.
 *
 * /v1/messages/count_tokens counts rather than generates, so running this is
 * free. Same dedicated key as every other outbound call from this server; no
 * key prints characters and says the token figures are missing.
 *
 * The transcript below is invented. The repo is public.
 */
import { readFileSync } from 'node:fs';
import type { NotesComposeInput } from '../packages/server/src/meeting-notes.ts';
import { NOTES_AUTHOR_ID } from '../packages/server/src/notes-doc-access.ts';
import { buildNotesPrompt } from '../packages/server/src/notes-prompt-build.ts';
import { DEFAULT_NOTES_INSTRUCTIONS } from '../packages/server/src/notes-prompt-store.ts';
import { readKeychainPassword } from '../packages/server/src/share/keychain.ts';
import { resolveKeyFrom } from '../packages/server/src/summarize.ts';

const MODEL = 'claude-haiku-4-5-20251001';

/**
 * A tick in the MIDDLE of a meeting, not its first.
 *
 * The first tick's prompt is the instructions and four lines of speech; every
 * later one also carries the notes so far, which is what the compose actually
 * costs for most of a meeting. Pricing tick one would flatter the number.
 */
const INPUT: NotesComposeInput = {
  docId: 'd-cost',
  meetingId: 'm-cost',
  tick: {
    tick: 7,
    reason: 'pause',
    turns: [
      {
        turn: 51,
        text: 'The retry loop is waking the sync every ninety seconds.',
        speaker: 'Priya',
        speakerLabel: 'A',
      },
      {
        turn: 52,
        text: 'That is the backoff never resetting after a success.',
        speaker: 'Marcus',
        speakerLabel: 'B',
      },
      {
        turn: 53,
        text: 'Let us cap it at ten minutes and ship that this week.',
        speaker: 'Priya',
        speakerLabel: 'A',
      },
      {
        turn: 54,
        text: 'I will take it. Thursday at the latest.',
        speaker: 'Marcus',
        speakerLabel: 'B',
      },
    ],
  },
  // The doc a mid-meeting tick reads back: the section this meeting opened,
  // the topic headings under it, its own bullets — and one line a person
  // typed, which is what carries no author.
  outline: [
    {
      id: 'h1',
      kind: 'heading',
      nodeName: 'heading',
      level: 2,
      text: 'Meeting notes',
      author: NOTES_AUTHOR_ID,
    },
    {
      id: 'h2',
      kind: 'heading',
      nodeName: 'heading',
      level: 3,
      text: 'Sync wakes too often',
      author: NOTES_AUTHOR_ID,
      underHeadingId: 'h1',
    },
    {
      id: 'b1',
      kind: 'listItem',
      nodeName: 'listItem',
      text: '[@Priya](speaker:A) The sync wakes on a ninety-second retry loop.',
      author: NOTES_AUTHOR_ID,
      underHeadingId: 'h2',
    },
    {
      id: 'b2',
      kind: 'listItem',
      nodeName: 'listItem',
      text: '[@Marcus](speaker:B) Cause: backoff never resets after a successful run.',
      author: NOTES_AUTHOR_ID,
      underHeadingId: 'h2',
    },
    {
      id: 'h3',
      kind: 'heading',
      nodeName: 'heading',
      level: 3,
      text: 'Export range',
      author: NOTES_AUTHOR_ID,
      underHeadingId: 'h1',
    },
    {
      id: 'b3',
      kind: 'listItem',
      nodeName: 'listItem',
      text: '[@Marcus](speaker:B) The export dialog forgets the range between opens.',
      author: NOTES_AUTHOR_ID,
      underHeadingId: 'h3',
    },
    {
      id: 'b4',
      kind: 'listItem',
      nodeName: 'listItem',
      text: 'check whether this predates the 0.4 rollout',
      underHeadingId: 'h3',
    },
  ],
  notesHeadingId: 'h1',
  humanNotes: ['check whether this predates the 0.4 rollout'],
  context: {
    docTitle: 'Weekly sync',
    taskTitles: [
      'Retry loop wakes the sync every ninety seconds',
      'Export dialog forgets the chosen range',
      'Lantern badge counts stale invites',
    ],
  },
  references: [
    {
      kind: 'task',
      title: 'Retry loop wakes the sync every ninety seconds',
      url: '/workspaces/w-1?task=t-3',
    },
  ],
};

async function countTokens(key: string, system: string, user: string): Promise<number> {
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`count_tokens HTTP ${res.status}`);
  return ((await res.json()) as { input_tokens: number }).input_tokens;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf('--baseline');
  const baselineFile = at >= 0 ? args[at + 1] : undefined;
  const keyAt = args.indexOf('--api-key');
  const key = resolveKeyFrom(keyAt >= 0 ? args[keyAt + 1] : undefined, readKeychainPassword);

  const now = buildNotesPrompt(INPUT, DEFAULT_NOTES_INSTRUCTIONS);
  const baseline = baselineFile
    ? buildNotesPrompt(INPUT, readFileSync(baselineFile, 'utf8').trimEnd())
    : null;

  console.log(`model: ${MODEL}`);
  console.log(`instructions: ${DEFAULT_NOTES_INSTRUCTIONS.length} chars`);
  console.log(`user message: ${now.user.length} chars`);
  if (!key) {
    console.log('\nNo dedicated key — character counts only, no token figures.');
    if (baseline) {
      console.log(`baseline instructions: ${baseline.system.length} chars`);
    }
    return;
  }

  const nowTokens = await countTokens(key, now.system, now.user);
  console.log(`\nper tick: ${nowTokens} input tokens`);
  if (baseline) {
    const wasTokens = await countTokens(key, baseline.system, baseline.user);
    const delta = nowTokens - wasTokens;
    console.log(`baseline: ${wasTokens} input tokens`);
    console.log(`delta:    ${delta >= 0 ? '+' : ''}${delta} input tokens per tick`);
    // 200 ticks is the meeting-hour figure the architecture summary prices
    // everything else at; keeping the same divisor is what makes this number
    // comparable to the ones already written down.
    const perHour = (delta * 200) / 1_000_000;
    console.log(
      `at 200 ticks/hour and $1/MTok: ${perHour >= 0 ? '+' : ''}$${perHour.toFixed(4)} per meeting-hour`,
    );
  }
}

await main();
