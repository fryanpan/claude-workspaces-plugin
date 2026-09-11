import { CAPTURE_ITEM_SHAPES } from '../packages/server/src/meeting-capture-prompt.ts';
/**
 * What the research, lookup and correction intents cost the capture prompt,
 * per tick.
 *
 * The 2026-08-30 decision ("One call per tick carries every intent") priced a
 * new intent at ~58 input and ~21 output tokens when it rides the existing
 * call, against seven to twenty-seven times that as its own always-on pass.
 * The intents added since are the first to be added under that decision, so
 * the number is worth measuring rather than inheriting: this prints the input
 * side, measured by the same token counter the call is billed by.
 *
 * The stages are cumulative and in the order the intents landed, so each
 * `(+n)` is that intent's own standing cost per tick — what it adds to every
 * prompt whether or not anybody corrects a note on that tick.
 *
 *   bun run scripts/intent-prompt-cost.ts
 *
 * Same key and same cost as `capture-overlap-cost.ts`: the dedicated capture
 * key (Keychain or `--api-key`), and /v1/messages/count_tokens counts rather
 * than generates, so running it is free. With no key it prints the character
 * delta and says the token figures are estimates.
 *
 * The output side is NOT measured here. An intent's output tokens are what
 * the model chooses to say, so they are a property of real meetings, not of
 * a prompt — the empty answer this pass gives on most ticks costs nothing at
 * all, and the tick that carries a research ask is the one worth pricing.
 *
 * The transcript below is invented. The repo is public.
 */
import type { NotesTurn } from '../packages/server/src/meeting-notes.ts';
import { buildTaskCapturePrompt } from '../packages/server/src/meeting-task-capture.ts';
import { withoutSection } from '../packages/server/src/prompt-sections.ts';
import { readKeychainPassword } from '../packages/server/src/share/keychain.ts';
import { resolveKeyFrom } from '../packages/server/src/summarize.ts';

const MODEL = 'claude-haiku-4-5-20251001';

const candidates = [
  { id: 't-1', title: 'Lantern badge counts stale invites', status: 'todo' as const },
  { id: 't-2', title: 'Export dialog forgets the chosen range', status: 'in-progress' as const },
  { id: 't-3', title: 'Retry loop wakes the sync every ninety seconds', status: 'todo' as const },
];

/** A tick carrying every new intent, which is the tick worth pricing. */
const tick: NotesTurn[] = [
  { turn: 51, speaker: 'Priya', text: 'Can somebody go look into why the retry loop wakes it?' },
  { turn: 52, speaker: 'Marcus', text: "And pull in last week's notes while you are at it." },
  { turn: 53, speaker: 'Priya', text: 'And no, I said Thursday for the gate, not Tuesday.' },
  { turn: 54, speaker: 'Marcus', text: 'Ask the team whether we still need the gate at all.' },
];

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

/**
 * The prompt without one intent: its `###` section removed by heading, and
 * its line struck from the output format. Both are standing text paid on
 * every tick, so both belong in the delta. Throws when either is missing, so
 * a reworded prompt fails loudly instead of pricing an intent at zero.
 */
function without(system: string, heading: string, kind: string): string {
  const cut = withoutSection(system, heading);
  if (cut === system) throw new Error(`baseline strip found no "### ${heading}" section`);
  const shape = CAPTURE_ITEM_SHAPES.find((line) => line.startsWith(`{"kind":"${kind}"`));
  if (!shape || !cut.includes(`${shape}\n`)) {
    throw new Error(`baseline strip found no shape line for ${kind}`);
  }
  return cut.replace(`${shape}\n`, '');
}

async function main(): Promise<void> {
  const flagKey = process.argv.includes('--api-key')
    ? process.argv[process.argv.indexOf('--api-key') + 1]
    : undefined;
  const key = resolveKeyFrom(flagKey, readKeychainPassword);

  const built = buildTaskCapturePrompt({ turns: tick, candidates });
  const beforeReview = without(built.system, 'Review', 'review');
  const beforeCorrection = without(beforeReview, 'Correction', 'correction');
  const noLookup = without(beforeCorrection, 'Lookup', 'lookup');
  const neither = without(noLookup, 'Research', 'research');

  const stages: Array<[string, string]> = [
    ['requests + references only', neither],
    ['+ research', noLookup],
    ['+ lookup', beforeCorrection],
    ['+ correction', beforeReview],
    ['+ review ask (shipped)', built.system],
  ];

  console.log('system prompt, characters:');
  let prevChars = 0;
  for (const [label, system] of stages) {
    const n = system.length;
    console.log(`  ${label}: ${n}${prevChars ? `  (+${n - prevChars})` : ''}`);
    prevChars = n;
  }

  if (!key) {
    console.log('\nno dedicated key — token figures would be chars/4 ESTIMATES, so:');
    console.log(`  ~+${Math.round((built.system.length - neither.length) / 4)} tokens per tick`);
    console.log('  run with the capture key for the measured number.');
    return;
  }

  console.log(`\nmeasured on ${MODEL} (count_tokens), whole prompt:`);
  let prev = 0;
  for (const [label, system] of stages) {
    const n = await countTokens(key, system, built.user);
    console.log(`  ${label}: ${n}${prev ? `  (+${n - prev})` : ''}`);
    prev = n;
  }
}

await main();
