/**
 * WHICH SLOT PAID, and that a run says so in its own record.
 *
 * Two halves. The first is the vocabulary: a slot is a configured NAME and a
 * role, the role comes from which name was consulted, and an unmapped name is
 * refused rather than defaulted. The second is the one the task is actually
 * about — a real notes tick, driven end to end against a stubbed API, writes
 * a timing row that names the Keychain item that will be billed. Reading the
 * config would have proved neither.
 *
 * NOTHING HERE HANDLES A KEY. The one value that stands in for a credential
 * is an obvious placeholder, and the last assertion of the run case is that
 * it does not appear anywhere in the record that was written.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCESS_TOKEN_SLOT,
  EXPLICIT_SLOT,
  claudeKeySlots,
  claudeSlotTrace,
  describeSlotUse,
  noteClaudeSlot,
  resetClaudeSlotTrace,
  slotForService,
} from '../src/claude-key-slot.ts';
import {
  ACCESS_TOKEN_ENV,
  EVAL_KEYCHAIN_SERVICE,
  KEYCHAIN_SERVICE,
  KEYCHAIN_SERVICE_LEGACY,
  LAUNCHD_JOB_ENV,
  PROD_SERVICE_LABEL,
} from '../src/claude-key-source.ts';
import { createHaikuNotesComposer } from '../src/meeting-notes-composer.ts';
import { beginNotesSession } from '../src/meeting-notes.ts';
import type { NotesTickTiming } from '../src/notes-timing.ts';
import { createNotesTimingLog } from '../src/notes-timing.ts';
import { resolveCredentialSlotFrom, resolveKeySlotFrom } from '../src/summarize.ts';
import { ManualScheduler } from './notes-tick-harness.ts';

const PROD_ENV = { [LAUNCHD_JOB_ENV]: PROD_SERVICE_LABEL };

/** Not a credential. It stands in for one so a lookup can resolve. */
const PLACEHOLDER = 'placeholder-no-request-is-made-with-this';

/** A keychain whose answer depends only on which name it was asked for. */
function keychain(held: Record<string, string>): (service: string) => string | null {
  return (service) => held[service] ?? null;
}

afterEach(() => {
  resetClaudeSlotTrace();
});

describe('a slot is a name and a role', () => {
  it('gives prod’s two item names the prod role and the eval item the eval role', () => {
    expect(slotForService(KEYCHAIN_SERVICE)).toEqual({ name: KEYCHAIN_SERVICE, role: 'prod' });
    expect(slotForService(KEYCHAIN_SERVICE_LEGACY)).toEqual({
      name: KEYCHAIN_SERVICE_LEGACY,
      role: 'prod',
    });
    expect(slotForService(EVAL_KEYCHAIN_SERVICE)).toEqual({
      name: EVAL_KEYCHAIN_SERVICE,
      role: 'eval',
    });
  });

  it('refuses a name nobody mapped, rather than defaulting it to the safe role', () => {
    // A default is how a new item comes to spend prod's money while the
    // record says "eval". The refusal is the point.
    expect(() => slotForService('claude-workspaces-some-new-item')).toThrow();
  });

  it('offers the eval slot outside prod and prod’s two inside it', () => {
    expect(claudeKeySlots({}).map((s) => s.role)).toEqual(['eval']);
    expect(claudeKeySlots(PROD_ENV).map((s) => s.role)).toEqual(['prod', 'prod']);
  });

  it('reads back as a line naming the path, the slot and the role', () => {
    expect(
      describeSlotUse({ path: 'review-gate', slot: slotForService(EVAL_KEYCHAIN_SERVICE) }),
    ).toBe(`review-gate: ${EVAL_KEYCHAIN_SERVICE} (eval)`);
    expect(describeSlotUse({ path: 'review-gate', slot: null })).toBe('review-gate: no credential');
  });
});

describe('resolution records which slot answered', () => {
  it('names the eval item outside prod and prod’s item inside it', () => {
    const read = keychain({
      [EVAL_KEYCHAIN_SERVICE]: PLACEHOLDER,
      [KEYCHAIN_SERVICE]: PLACEHOLDER,
    });
    expect(resolveKeySlotFrom('review-gate', undefined, read, {})?.slot).toEqual({
      name: EVAL_KEYCHAIN_SERVICE,
      role: 'eval',
    });
    expect(resolveKeySlotFrom('review-gate', undefined, read, PROD_ENV)?.slot).toEqual({
      name: KEYCHAIN_SERVICE,
      role: 'prod',
    });
    expect(claudeSlotTrace()).toEqual([
      { path: 'review-gate', slot: { name: KEYCHAIN_SERVICE, role: 'prod' } },
    ]);
  });

  it('falls to prod’s pre-rename name, and still calls it prod', () => {
    const read = keychain({ [KEYCHAIN_SERVICE_LEGACY]: PLACEHOLDER });
    expect(resolveKeySlotFrom('thread-summary', undefined, read, PROD_ENV)?.slot).toEqual({
      name: KEYCHAIN_SERVICE_LEGACY,
      role: 'prod',
    });
  });

  it('records the no-credential answer rather than leaving the path absent', () => {
    expect(resolveKeySlotFrom('voice-complete', undefined, keychain({}), {})).toBeNull();
    expect(claudeSlotTrace()).toEqual([{ path: 'voice-complete', slot: null }]);
  });

  it('says so when a value was handed in instead of read from a slot', () => {
    const r = resolveKeySlotFrom('cost-script', 'typed-by-hand', keychain({}), {});
    expect(r?.slot).toEqual(EXPLICIT_SLOT);
    expect(EXPLICIT_SLOT.role).toBe('explicit');
  });

  it('names the access token’s variable when the environment holds one', () => {
    const r = resolveCredentialSlotFrom('meeting-notes-compose', undefined, keychain({}), {
      [ACCESS_TOKEN_ENV]: 'tok-minted-for-this-run',
    });
    expect(r?.credential.kind).toBe('token');
    expect(r?.slot).toEqual(ACCESS_TOKEN_SLOT);
    expect(ACCESS_TOKEN_SLOT.name).toBe(ACCESS_TOKEN_ENV);
  });

  it('never puts the value, or anything derived from it, in the slot', () => {
    const read = keychain({ [EVAL_KEYCHAIN_SERVICE]: PLACEHOLDER });
    const r = resolveCredentialSlotFrom('answer-coverage', undefined, read, {});
    expect(r?.credential.value).toBe(PLACEHOLDER);
    expect(JSON.stringify(r?.slot)).not.toContain(PLACEHOLDER);
    expect(JSON.stringify(claudeSlotTrace())).not.toContain(PLACEHOLDER);
  });

  it('keeps one answer per path, the latest', () => {
    const read = keychain({ [EVAL_KEYCHAIN_SERVICE]: PLACEHOLDER });
    resolveKeySlotFrom('meeting-namer', undefined, read, {});
    resolveKeySlotFrom('meeting-namer', undefined, keychain({}), {});
    expect(claudeSlotTrace()).toEqual([{ path: 'meeting-namer', slot: null }]);
    noteClaudeSlot('meeting-namer', slotForService(EVAL_KEYCHAIN_SERVICE));
    expect(claudeSlotTrace()[0]?.slot?.role).toBe('eval');
  });
});

describe('a meeting’s own timing record says which slot paid', () => {
  it('writes the eval item and its role beside the tick that spent it', async () => {
    // A REAL TICK, not a constructed row: the shipped composer resolves its
    // own credential through the same Keychain seam the server uses, posts to
    // a stubbed API, and the session writes the JSONL a live meeting writes.
    const dir = mkdtempSync(join(tmpdir(), 'cw-key-slot-'));
    const path = join(dir, 'timing.jsonl');
    const priorOverride = process.env[EVAL_KEYCHAIN_SERVICE.toUpperCase().replace(/-/g, '_')];
    const priorMarker = process.env[LAUNCHD_JOB_ENV];
    process.env[EVAL_KEYCHAIN_SERVICE.toUpperCase().replace(/-/g, '_')] = PLACEHOLDER;
    Reflect.deleteProperty(process.env, LAUNCHD_JOB_ENV);
    try {
      const composer = createHaikuNotesComposer({
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              content: [
                { text: '[{"op":"insert_at_end","markdown":"## Notes\\n\\n- the sync is slow"}]' },
              ],
              stop_reason: 'end_turn',
              usage: { input_tokens: 11, output_tokens: 3 },
            }),
          )) as unknown as typeof fetch,
      });
      expect(composer).not.toBeNull();
      if (composer === null) return;

      let now = 1_000;
      const schedule = new ManualScheduler();
      const timing = createNotesTimingLog({ path });
      const session = beginNotesSession(
        {
          composer,
          quietMs: 1_000,
          schedule,
          now: () => now,
          openTiming: () => timing,
          onNotes: () => {},
        },
        { docId: 'doc-key-slot', meetingId: 'm-key-slot' },
      );
      session.onTurn({ turn: 0, text: 'Say which key paid for this.', final: true });
      now += 4_000;
      schedule.fire();
      await session.end();

      const written = readFileSync(path, 'utf8');
      // The file's last line is the meeting's summary, which carries no
      // calls; the tick rows are the ones that priced anything.
      const rows = written
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Partial<NotesTickTiming>)
        .filter((r): r is NotesTickTiming => Array.isArray(r.calls));
      const paid = rows.flatMap((r) => r.calls).filter((c) => c.call === 'compose');
      expect(paid.length).toBeGreaterThan(0);
      expect(paid[0]?.keySlot).toEqual({ name: EVAL_KEYCHAIN_SERVICE, role: 'eval' });
      // THE RULE THE RECORD EXISTS UNDER: a slot, never the credential and
      // never anything derived from it.
      expect(written).not.toContain(PLACEHOLDER);
    } finally {
      if (priorOverride === undefined) {
        Reflect.deleteProperty(process.env, EVAL_KEYCHAIN_SERVICE.toUpperCase().replace(/-/g, '_'));
      } else {
        process.env[EVAL_KEYCHAIN_SERVICE.toUpperCase().replace(/-/g, '_')] = priorOverride;
      }
      if (priorMarker !== undefined) process.env[LAUNCHD_JOB_ENV] = priorMarker;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
