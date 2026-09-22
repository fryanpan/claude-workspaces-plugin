#!/usr/bin/env bun
/**
 * Does a dictated layout come back as the speaker said it?
 *
 *   bun run notes:fidelity                     # one run, capped at $0.50
 *   bun run notes:fidelity --runs 3 --max-usd 1
 *   bun run notes:fidelity --instructions <file>   # score another prompt
 *   bun run notes:fidelity --notes-out <dir>       # keep each run's notes
 *
 * WHAT IT MEASURES. One invented dictation (`notes-fidelity-dictation.ts`)
 * with the shapes a real one had: two pages laid out with "start with… then…
 * the last thing", three claims spoken with a "because", a stated problem, a
 * repave, a question and an ask. It is played through the REAL composer tick
 * by tick, and the notes it ends with are scored in code
 * (`notes-fidelity-score.ts`): the share of pages that came out as a numbered
 * list in the dictated order under a heading in the speaker's words, and the
 * share of "because" claims whose reason sits in the same bullet. The
 * stop-time quality report is built over the same notes, so its inversion and
 * duplicate counts are printed beside them.
 *
 * ON DEMAND ONLY, on the eval credential (`eval-credential.ts`), never prod's.
 * A run is sixteen Haiku composes, measured at about $0.035 to $0.04 (three
 * runs, $0.10 to $0.11); `--max-usd` stops the run before the next call once
 * the spend passes it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHaikuNotesComposer } from '../packages/server/src/meeting-notes-composer.ts';
import { buildNotesQualityReport } from '../packages/server/src/notes-quality-report.ts';
import { readKeychainPassword } from '../packages/server/src/share/keychain.ts';
import { createNotesTickHarness } from '../packages/server/test/notes-tick-harness.ts';
import { EVAL_CREDENTIAL_HELP, resolveEvalCredentialFrom } from './eval-credential.ts';
import { BECAUSE_IDEAS, DICTATED_PAGES, DICTATION_TICKS } from './notes-fidelity-dictation.ts';
import { causeRetention, pageOrderScore } from './notes-fidelity-score.ts';

/** Haiku 4.5, dollars per token; cache writes at 1.25x, reads at 0.1x. */
const INPUT = 1 / 1_000_000;
const OUTPUT = 5 / 1_000_000;

interface Options {
  runs: number;
  maxUsd: number;
  instructions?: string;
  notesOut?: string;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { runs: 1, maxUsd: 0.5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--runs') opts.runs = Number(next());
    else if (a === '--max-usd') opts.maxUsd = Number(next());
    else if (a === '--instructions') opts.instructions = readFileSync(next(), 'utf8');
    else if (a === '--notes-out') opts.notesOut = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error('--runs wants a count');
  if (!Number.isFinite(opts.maxUsd) || opts.maxUsd <= 0) throw new Error('--max-usd wants dollars');
  return opts;
}

async function main(argv: readonly string[]): Promise<number> {
  const opts = parseArgs(argv);
  const key = resolveEvalCredentialFrom(undefined, readKeychainPassword, process.env);
  if (!key) {
    console.error(EVAL_CREDENTIAL_HELP);
    return 2;
  }
  let spent = 0;
  const counting = Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      if (spent >= opts.maxUsd) throw new Error(`spend cap $${opts.maxUsd} reached`);
      const res = await globalThis.fetch(input as string, init);
      const body = (await res
        .clone()
        .json()
        .catch(() => null)) as { usage?: Record<string, number> } | null;
      const u = body?.usage ?? {};
      spent +=
        (u.input_tokens ?? 0) * INPUT +
        (u.cache_creation_input_tokens ?? 0) * INPUT * 1.25 +
        (u.cache_read_input_tokens ?? 0) * INPUT * 0.1 +
        (u.output_tokens ?? 0) * OUTPUT;
      return res;
    },
    { preconnect: globalThis.fetch.preconnect },
  ) as typeof fetch;
  const composer = createHaikuNotesComposer({
    apiKey: key.kind === 'key' ? key.value : undefined,
    fetchImpl: counting,
    ...(opts.instructions ? { instructions: (): string => opts.instructions as string } : {}),
  });
  if (!composer) throw new Error('no composer: the eval credential did not resolve');
  const transcript = DICTATION_TICKS.flatMap((t) => t.turns);

  const totals = { pages: 0, pagesKept: 0, ideas: 0, retained: 0 };
  for (let run = 1; run <= opts.runs; run++) {
    const harness = createNotesTickHarness({
      docId: `d-fidelity-${run}`,
      meetingId: `m-fidelity-${run}`,
      docTitle: 'Harborlight council update',
      tickTimeoutMs: 60_000,
      compose: async (input) => {
        const edits = await composer.compose(input);
        // CW_FIDELITY_OPS=1 prints what each tick answered, which is the
        // only way to tell a rule the model ignored from one the pipeline undid.
        if (process.env.CW_FIDELITY_OPS === '1') {
          const said = input.tick.turns.map((t) => t.text).join(' ');
          console.log(`  [ops] "${said.slice(0, 70)}" => ${JSON.stringify(edits)}`);
        }
        return edits;
      },
    });
    let failed = 0;
    for (const tick of DICTATION_TICKS) {
      try {
        await harness.speak(...tick.turns);
      } catch (err) {
        failed++;
        console.error(`  run ${run}: compose failed — ${String(err)}`);
      }
    }
    await harness.end().catch((err) => console.error(`  run ${run}: end failed — ${err}`));
    // The doc starts empty, so everything in it is the note-taker's: a
    // dictation opens its own headings rather than a "Meeting notes" section.
    const notes = harness.markdown();
    if (opts.notesOut) {
      mkdirSync(opts.notesOut, { recursive: true });
      writeFileSync(join(opts.notesOut, `run-${run}.md`), notes);
    }
    const order = pageOrderScore(notes, DICTATED_PAGES);
    const cause = causeRetention(notes, BECAUSE_IDEAS);
    const report = buildNotesQualityReport({ notes, transcript });
    totals.pages += DICTATED_PAGES.length;
    totals.pagesKept += order.kept;
    totals.ideas += BECAUSE_IDEAS.length;
    totals.retained += cause.retained;
    console.log(`run ${run}${failed > 0 ? ` (${failed} composes failed)` : ''}`);
    for (const [i, p] of order.pages.entries()) {
      console.log(`  page ${i + 1}: ${p.ok ? 'KEPT' : 'LOST'} — ${p.why} (heading: ${p.heading})`);
    }
    for (const c of cause.ideas) {
      console.log(
        `  because "${c.idea.claim.join(' ')}": ${c.bullet ? 'RETAINED' : c.claimed ? 'REASON APART' : 'CLAIM MISSING'}`,
      );
    }
    console.log(
      `  quality report: ${report.inversions.length} inverted notes, ` +
        `${report.duplicateBulletLines} repeated bullets of ${report.bullets}, ` +
        `flags: ${report.flags.map((f) => f.kind).join(', ') || 'none'}`,
    );
    for (const inv of report.inversions) {
      console.log(`    ${inv.kind}: "${inv.bullet}" <- "${inv.source}"`);
    }
  }
  const pct = (n: number, d: number): string => `${Math.round((100 * n) / d)}%`;
  console.log(
    `\npage order kept: ${totals.pagesKept}/${totals.pages} (${pct(totals.pagesKept, totals.pages)})` +
      `\ncause retention: ${totals.retained}/${totals.ideas} (${pct(totals.retained, totals.ideas)})` +
      `\nspent: $${spent.toFixed(4)}`,
  );
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
