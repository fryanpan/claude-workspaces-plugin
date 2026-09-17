/**
 * The SessionStart report: what a session is told about its own plugin
 * configuration at launch.
 *
 * The bug these cover is a SILENT one — a Stop hook that exits 0 with no board
 * looks identical to a quiet turn — so every case here is written against the
 * question "what would this observable be if the feature were broken?". For the
 * pure module the answer is `undefined` / an empty string, which is why each
 * case asserts on the CONTENT of the report and its absence separately: a test
 * that only asserted `toBeDefined()` would pass against a report that named
 * nothing.
 *
 * Fixtures are synthetic; board ids and agent names below are invented.
 */
import { describe, expect, it } from 'vitest';
import {
  type SessionStartReport,
  sessionStartOutput,
  sessionStartReport,
} from '../hooks/lib/session-report.ts';

const HEALTHY = {
  CW_AGENT_NAME: 'Harborlight',
  CW_WORKSPACE_ID: 'w-board',
};

describe('sessionStartReport', () => {
  it('says nothing at all when both settings are present', () => {
    expect(sessionStartReport(HEALTHY)).toBeUndefined();
  });

  it('accepts the pre-rename spellings, because the note hooks do', () => {
    // If this reported, every session still on the legacy environment would be
    // told its notes go nowhere while they were in fact landing — a false
    // alarm is as bad as the silence, because it trains the reader to skip.
    expect(
      sessionStartReport({
        FEEDBACK_AGENT_NAME: 'Harborlight',
        FEEDBACK_WORKSPACE_ID: 'w-board',
      }),
    ).toBeUndefined();
  });

  it('names the missing board variable, not just that something is wrong', () => {
    const report = sessionStartReport({ CW_AGENT_NAME: 'Harborlight' }) as SessionStartReport;
    expect(report).toBeDefined();
    expect(report.missing).toEqual(['CW_WORKSPACE_ID']);
    expect(report.text).toContain('CW_WORKSPACE_ID');
    // The legacy spelling is named too: a reader who sets only the old one
    // would otherwise set it and see the warning again next launch.
    expect(report.text).toContain('FEEDBACK_WORKSPACE_ID');
    // And it must not accuse the setting that IS present.
    expect(report.missing).not.toContain('CW_AGENT_NAME');
  });

  it('names the missing agent name when that is the half that is absent', () => {
    const report = sessionStartReport({ CW_WORKSPACE_ID: 'w-board' }) as SessionStartReport;
    expect(report?.missing).toEqual(['CW_AGENT_NAME']);
    expect(report.text).toContain('CW_AGENT_NAME');
  });

  it('names both when a session was launched with neither', () => {
    const report = sessionStartReport({}) as SessionStartReport;
    expect(report?.missing).toEqual(['CW_WORKSPACE_ID', 'CW_AGENT_NAME']);
    expect(report.text).toContain('CW_WORKSPACE_ID');
    expect(report.text).toContain('CW_AGENT_NAME');
  });

  it('treats a blank value as absent, the way the hook readers do', () => {
    // `CW_WORKSPACE_ID=` in a launcher script is the shape this actually takes
    // in the field, and it posts exactly as much as an unset one: nothing.
    const report = sessionStartReport({ CW_AGENT_NAME: 'Harborlight', CW_WORKSPACE_ID: '   ' });
    expect(report?.missing).toEqual(['CW_WORKSPACE_ID']);
  });

  it('says the notes are going nowhere, and that a mid-session fix will not help', () => {
    // The two things a reader has to conclude. Without the first they read it
    // as a style note; without the second they export the variable in a shell
    // that the already-launched hook will never see and believe they fixed it.
    const { text } = sessionStartReport({}) as SessionStartReport;
    expect(text).toMatch(/NOWHERE|not in the record/);
    expect(text).toMatch(/relaunch/i);
  });
});

describe('sessionStartOutput', () => {
  it('wraps the text in the one SessionStart field that reaches the model', () => {
    // SessionStart also adds plain stdout to context, so the envelope is not
    // the only way in — it is the DECLARED one, and the only shape that stays
    // correct if this hook is ever pointed at another event, where a bare line
    // on stdout is a `hook error` notice rather than context.
    const parsed = JSON.parse(sessionStartOutput('hello'));
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toBe('hello');
  });

  it('emits one line, because a hook writes its JSON on stdout', () => {
    expect(sessionStartOutput('a\nb')).not.toMatch(/\n/);
  });
});
