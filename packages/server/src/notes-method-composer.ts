/**
 * ONE COMPOSER THAT IS THREE, PICKED PER TICK from the doc's current method.
 *
 * `beginNotesSession` takes a single `NotesComposer` and the server builds it
 * once, so a method a person changes mid-meeting cannot be a different object
 * wired at start. This is the object that is wired instead: it reads the doc's
 * method at the top of every compose, runs the ledger's extract when that
 * method calls for one, and delegates to the composer for the model that
 * method composes on.
 *
 * WHY THE SWITCH IS PER TICK AND NOT PER SESSION. The whole feature is that a
 * person listening to notes arrive can decide the notes are too thin and buy
 * a better note-taker for the rest of the meeting. A per-session choice would
 * mean stopping the recording to change it, and a meeting stopped and
 * restarted is two meetings, two sections and two bills.
 *
 * NOTHING ALREADY WRITTEN IS REWRITTEN. A method change moves what the NEXT
 * tick composes with; the bullets above it stay as the method that wrote them
 * left them. That is the contract the trace line in the notes records.
 *
 * THE LEDGER SETTLES ON THE FOLLOWING TICK. `NotesLedger.after` needs the
 * notes as they now stand, and a composer never sees the write it caused —
 * so the carry is settled against `input.outline` at the top of the next
 * compose, which IS the doc as it currently reads. One seam, no extra
 * callback into the session, and a meeting whose last tick left points
 * unplaced simply never offers them again, which is right: there is no tick
 * after the last one to offer them to.
 */

import {
  DEFAULT_NOTES_METHOD,
  type NotesMethod,
  notesMethodUsesLedger,
} from '@claude-workspaces/core';
import type { prose } from '@claude-workspaces/core';
import { type HaikuNotesComposerOpts, createHaikuNotesComposer } from './meeting-notes-composer.ts';
import type { NotesComposeInput, NotesComposer } from './meeting-notes.ts';
import { type NotesLedger, createNotesLedger, nestedNotesInstructions } from './notes-ledger.ts';

/** The model each method composes on. `undefined` is the composer's own
 *  default, which is Haiku — the two cheap methods differ in whether they run
 *  an extract, not in what writes. */
const COMPOSE_MODEL: Record<NotesMethod, string | undefined> = {
  original: undefined,
  'ledger-haiku': undefined,
  'ledger-opus': 'claude-opus-5',
};

/** Raised with the model: Opus spends part of its ceiling thinking before it
 *  writes an edit, and a truncated edit list is refused outright. */
const OPUS_MAX_TOKENS = 4_000;

/**
 * How much of that ceiling it may think for.
 *
 * `low`, and the number matters: every Opus figure the exploration measured —
 * the lost-idea rate AND the price a meeting-hour costs — was measured with
 * effort low. Shipping the same method with the setting left off would run a
 * different, more expensive note-taker than the one the table is about, and
 * the eval could not honestly be compared against its own exploration.
 */
const OPUS_EFFORT = 'low';

/**
 * What a method composes with — the one table the shipped composer and
 * `scripts/notes-eval-variants.ts` both read.
 *
 * Exported because the eval's whole claim is that it measures the SHIPPED
 * note-takers. A second copy of these three settings in the script is how the
 * eval starts reporting on a note-taker nobody can select.
 */
export function composeSettings(method: NotesMethod): {
  model?: string;
  maxTokens?: number;
  effort?: string;
} {
  const model = COMPOSE_MODEL[method];
  return model ? { model, maxTokens: OPUS_MAX_TOKENS, effort: OPUS_EFFORT } : {};
}

/**
 * The most meetings whose ledger carry is held at once.
 *
 * A ledger is a few short strings and a meeting ends, so this is a guard
 * against a leak rather than a tuning knob: without it a server that ran for
 * months would hold one entry per meeting it had ever composed for.
 */
const MAX_LIVE_LEDGERS = 64;

export interface NotesMethodComposerDeps {
  /** The doc's method as it stands RIGHT NOW, read per tick. */
  methodFor: (docId: string) => NotesMethod;
  /** The key the ledger's extract calls with. Absent, no ledger runs and
   *  every method composes as the original — the same degradation a failed
   *  extract gets. */
  apiKey?: string | null;
  /** Passed through to each underlying composer: the instructions store, the
   *  test key, the test fetch. */
  composerOpts?: HaikuNotesComposerOpts;
  /** Test seam for the ledger's own HTTP call. */
  ledgerFetch?: typeof fetch;
  onError?: (message: string) => void;
}

/** The notes as the ledger should judge its carry against: the doc as this
 *  tick was handed it, bullets and headings alike, one line each. */
function outlineText(outline: readonly prose.OutlineEntry[]): string {
  return outline.map((e) => e.text).join('\n');
}

/**
 * The dispatching composer, or `null` when no composer could be built at all
 * — no dedicated key, or the operator turned notes off. Same contract as
 * `createHaikuNotesComposer`, because it is the thing this replaces.
 */
export function createNotesMethodComposer(deps: NotesMethodComposerDeps): NotesComposer | null {
  const base = deps.composerOpts ?? {};
  // Built once each, not per tick: each carries a resolved key and an
  // announcement latch, and constructing one per compose would re-resolve
  // the Keychain on every tick of every meeting.
  //
  // KEYED BY MODEL **AND** WRITING RULE, because the two cheap methods share
  // a model and do not share a prompt: a ledger method writes in two layers
  // (`nestedNotesInstructions`), which is what gives every point on the
  // checklist somewhere to go. Keyed by model alone, `ledger-haiku` would
  // silently reuse the original's composer and run as the original.
  const byBuild = new Map<string, NotesComposer>();
  const buildKey = (method: NotesMethod): string =>
    `${COMPOSE_MODEL[method] ?? 'default'}|${notesMethodUsesLedger(method) ? 'nested' : 'flat'}`;
  for (const method of Object.keys(COMPOSE_MODEL) as NotesMethod[]) {
    const key = buildKey(method);
    if (byBuild.has(key)) continue;
    const instructions = base.instructions;
    const composer = createHaikuNotesComposer({
      ...base,
      ...composeSettings(method),
      ...(notesMethodUsesLedger(method) && instructions
        ? {
            // Re-read per tick like the store it wraps, so an edit on the
            // settings page reaches a ledger method the same tick it reaches
            // the original.
            instructions: (): string => nestedNotesInstructions(instructions(), deps.onError),
          }
        : {}),
    });
    // A NULL HERE IS THE WHOLE FEATURE OFF, not this method off: every
    // method resolves the same key from the same place, so if one cannot be
    // built none can. Answered as `null` so the caller keeps the "notes stay
    // off" path it already has.
    if (!composer) return null;
    byBuild.set(key, composer);
  }

  const ledgers = new Map<string, NotesLedger>();
  function ledgerFor(meetingId: string): NotesLedger | null {
    // `undefined` means "not said, use the composer's"; an explicit `null`
    // means "there is no key for the ledger", and the two must not collapse:
    // `?? base.apiKey` would hand a deliberate null the compose key back.
    const key = deps.apiKey === undefined ? base.apiKey : deps.apiKey;
    if (!key) return null;
    const held = ledgers.get(meetingId);
    if (held) return held;
    if (ledgers.size >= MAX_LIVE_LEDGERS) {
      // Oldest first: a Map iterates in insertion order, and the meeting
      // inserted longest ago is the one least likely to compose again.
      const oldest = ledgers.keys().next();
      if (!oldest.done) ledgers.delete(oldest.value);
    }
    const made = createNotesLedger({
      apiKey: key,
      ...(deps.ledgerFetch ? { fetchImpl: deps.ledgerFetch } : {}),
      ...(deps.onError ? { onError: deps.onError } : {}),
    });
    ledgers.set(meetingId, made);
    return made;
  }

  return {
    name: 'method',
    async compose(input: NotesComposeInput): Promise<readonly prose.BlockEdit[]> {
      let method: NotesMethod;
      try {
        method = deps.methodFor(input.docId);
      } catch (err) {
        // A STORE THAT CANNOT ANSWER IS THE DEFAULT, never a failed tick.
        // The method is a preference; losing the notes over an unreadable
        // preference file would be the worse failure by far.
        deps.onError?.(
          `notes method unreadable for ${input.docId}: ${err instanceof Error ? err.message : 'error'}`,
        );
        method = DEFAULT_NOTES_METHOD;
      }
      const composer = byBuild.get(buildKey(method));
      // Unreachable while the table covers the union and the loop above
      // built every entry in it; the original's build is the safe read.
      const use = composer ?? byBuild.get(buildKey(DEFAULT_NOTES_METHOD));
      if (!use) throw new Error('no notes composer for method ' + method);

      const ledger = notesMethodUsesLedger(method) ? ledgerFor(input.meetingId) : null;
      if (!ledger) return use.compose(input);

      // Settle the PREVIOUS tick's carry first: the outline this tick was
      // handed is the notes as they now stand, which is exactly what the
      // carry has to be judged against.
      ledger.after(outlineText(input.outline));
      const checklist = await ledger.before(input.tick.turns);
      if (checklist.length === 0) return use.compose(input);
      return use.compose({
        ...input,
        // Appended, never replacing: a variant or a future caller that set
        // its own extra block keeps it, and the checklist follows it.
        extraPrompt: input.extraPrompt ? `${input.extraPrompt}\n\n${checklist}` : checklist,
      });
    },
  };
}
