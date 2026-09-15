/**
 * A WALLED RUN IS ASKED TO OPEN A TOPIC WHENEVER NO TOPIC NAMES IT — not only
 * when no heading at all stands above it.
 *
 * `homelessRun` used to ask "is there a heading above this run", which is the
 * same question as "does a topic name it" only on a doc with no structure of
 * its own. A person preparing for a meeting writes structure: `## Meeting
 * notes` and an agenda under it. On the real meeting that prompted this, every
 * note landed under the agenda, so every run had a `##` heading above it and
 * could only ever be asked to NEST — 192 bullets, zero topic headings.
 *
 * The replay at the bottom is the measurement the change is judged on: the
 * same outline through the old rule and the new one, counting the topic
 * headings each asks for.
 *
 * All fixtures are synthetic.
 */

import { describe, expect, test } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { homelessRun, regroupDirective, regroupTargets } from '../src/notes-regroup.ts';

const AUTHOR = 'notes-agent';

/** An outline off real markdown, with every bullet the note-taker's own. */
function outlineOf(markdown: string): readonly prose.OutlineEntry[] {
  const doc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(doc), markdown);
  prose.ensureBlockIds(doc);
  return prose.readOutline(doc).map((e) => (e.kind === 'heading' ? e : { ...e, author: AUTHOR }));
}

const FIVE_BULLETS = [
  '- the slipway queue holds the timetable up',
  '- the crane booking moves with it',
  '- the tide tables decide the sailings',
  '- the harbour lights are on the same budget',
  '- the ferry contract renews in March',
].join('\n');

describe('a run under a section heading has no topic', () => {
  test("bullets under the meeting's own heading are asked for a topic", () => {
    const outline = outlineOf(`## Meeting notes\n\n${FIVE_BULLETS}\n`);
    const run = homelessRun(outline, { author: AUTHOR });
    expect(run?.runLength).toBe(5);
    expect(run?.under?.heading).toBe('Meeting notes');
    expect(regroupTargets(outline, { author: AUTHOR })).toEqual([]);
    const directive = regroupDirective(outline, { author: AUTHOR });
    expect(directive).toContain('OPEN');
    expect(directive).toContain('is a SECTION, not a topic');
    expect(directive).not.toContain('nest_blocks');
  });

  test("bullets under somebody's agenda are asked for a topic", () => {
    const outline = outlineOf(`## Meeting notes\n\n## Agenda\n\n${FIVE_BULLETS}\n`);
    const run = homelessRun(outline, { author: AUTHOR });
    expect(run?.under?.heading).toBe('Agenda');
    expect(regroupTargets(outline, { author: AUTHOR })).toEqual([]);
  });

  test('a run above every heading still reads as homeless, with no heading named', () => {
    const outline = outlineOf(`${FIVE_BULLETS}\n\n## Agenda\n`);
    const run = homelessRun(outline, { author: AUTHOR });
    expect(run?.runLength).toBe(5);
    expect(run?.under).toBeUndefined();
    expect(regroupDirective(outline, { author: AUTHOR })).toContain('UNDER NO HEADING');
  });
});

describe('a run under a real topic is still asked to nest', () => {
  test('a `###` heading names the topic, so the remedy is a group', () => {
    const outline = outlineOf(`## Meeting notes\n\n### Ferry timetable\n\n${FIVE_BULLETS}\n`);
    expect(homelessRun(outline, { author: AUTHOR })).toBeNull();
    const targets = regroupTargets(outline, { author: AUTHOR });
    expect(targets).toHaveLength(1);
    expect(targets[0]?.heading).toBe('Ferry timetable');
    expect(regroupDirective(outline, { author: AUTHOR })).toContain('nest_blocks');
  });

  test('a topic under a section takes the nest and the section takes the topic ask', () => {
    // Four flat bullets under the section, then a full topic below them: the
    // section's run wants a heading and the topic's wants a group, and the
    // homeless ask is printed first because the other cannot happen until a
    // heading exists.
    const outline = outlineOf(
      `## Meeting notes\n\n${FIVE_BULLETS}\n\n### Ferry timetable\n\n${FIVE_BULLETS}\n`,
    );
    const directive = regroupDirective(outline, { author: AUTHOR }) ?? '';
    expect(directive.indexOf('OPEN')).toBeLessThan(directive.indexOf('nest_blocks'));
    expect(regroupTargets(outline, { author: AUTHOR })).toHaveLength(1);
  });

  test('a short run under a section is left alone', () => {
    const outline = outlineOf('## Meeting notes\n\n- one point\n- two points\n');
    expect(homelessRun(outline, { author: AUTHOR })).toBeNull();
    expect(regroupDirective(outline, { author: AUTHOR })).toBeNull();
  });
});

describe('replay: how many topic headings each rule asks for', () => {
  /**
   * The old rule, replayed: a run was homeless only when NO heading stood
   * above it. Kept here as the thing being measured against, not imported —
   * it no longer exists in the module.
   */
  function oldRuleAsksForHeading(outline: readonly prose.OutlineEntry[], bar = 4): boolean {
    let seenHeading = false;
    let run = 0;
    let asked = false;
    for (const entry of outline) {
      if (entry.kind === 'heading') {
        if (!seenHeading && run >= bar) asked = true;
        seenHeading = true;
        run = 0;
        continue;
      }
      if (entry.kind !== 'listItem') continue;
      if ((entry.depth ?? 0) > 0) {
        run = 0;
        continue;
      }
      run++;
    }
    if (!seenHeading && run >= bar) asked = true;
    return asked;
  }

  /** The doc the measured meeting actually had: a prepared page whose notes
   *  all landed under the agenda below the notes heading. */
  const MEASURED = outlineOf(
    [
      '## Meeting notes',
      '',
      '## Agenda',
      '',
      FIVE_BULLETS,
      '- the pontoon survey is overdue',
      '- the winter timetable needs signing off',
      '',
    ].join('\n'),
  );

  test('the old rule asks for none on it, the new rule asks for one', () => {
    expect(oldRuleAsksForHeading(MEASURED)).toBe(false);
    expect(homelessRun(MEASURED, { author: AUTHOR })).not.toBeNull();
  });

  test('and neither rule asks for a heading a real topic already has', () => {
    const grouped = outlineOf(`## Meeting notes\n\n### Ferry timetable\n\n${FIVE_BULLETS}\n`);
    expect(oldRuleAsksForHeading(grouped)).toBe(false);
    expect(homelessRun(grouped, { author: AUTHOR })).toBeNull();
  });
});
