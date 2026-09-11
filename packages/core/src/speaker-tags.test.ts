import { describe, expect, it } from 'vitest';
import {
  MAX_SPEAKER_TAG_TURNS,
  type SpeakerRevisions,
  escapeTagText,
  findSpeakerTags,
  normalizeSpeakerTags,
  parseSpeakerTagHref,
  reattributeSpeakerTags,
  renameSpeakerTags,
  renderSpeakerTag,
  speakerLabelsIn,
  speakerTagHref,
  speakerTagLabel,
} from './speaker-tags.ts';

/** A revision reads better as a literal than as a Map constructor. */
function revisions(entries: Record<number, string | null>): SpeakerRevisions {
  return new Map(Object.entries(entries).map(([turn, label]) => [Number(turn), label]));
}

describe('the tag itself', () => {
  it('is a markdown link whose href carries the label and whose text carries the name', () => {
    expect(renderSpeakerTag('B', { B: 'Mallory' })).toBe('[@Mallory](speaker:B)');
    expect(renderSpeakerTag('B', {})).toBe('[@Speaker B](speaker:B)');
  });

  it('reads a label back out of its own href, and nothing out of any other', () => {
    expect(speakerTagLabel(speakerTagHref('B'))).toBe('B');
    expect(speakerTagLabel('/w/w-1/t/t-1')).toBeNull();
    expect(speakerTagLabel('https://example.com/speaker:B')).toBeNull();
    // A scheme with nothing after it names no voice.
    expect(speakerTagLabel('speaker:')).toBeNull();
  });
});

describe('findSpeakerTags', () => {
  it('finds tags among ordinary links and leaves the ordinary ones alone', () => {
    const md = '- [@Mallory](speaker:B) will file [the ticket](/w/w-1/t/t-1) today.';
    expect(findSpeakerTags(md)).toEqual([
      {
        start: 2,
        end: 23,
        label: 'B',
        turns: [],
        claimsTurns: false,
        unsure: false,
        text: '@Mallory',
        raw: '[@Mallory](speaker:B)',
      },
    ]);
  });

  it('reports every voice a note attributes anything to, once each', () => {
    const md =
      '[@Mallory](speaker:B) disagreed with [@Dave](speaker:A); [@Mallory](speaker:B) won.';
    expect(speakerLabelsIn(md)).toEqual(['B', 'A']);
  });

  it('does not read a bracketed phrase inside link text as a tag', () => {
    expect(findSpeakerTags('[see [1] below](speaker:B)')).toEqual([]);
  });
});

describe('a name with markdown in it', () => {
  // Names come from a free-text prompt, so "Dave [PM]" is reachable. Written
  // raw it produces `[@Dave [PM]](speaker:B)`, which the finder cannot see —
  // and an unfindable tag is one normalization skips and every later rename
  // silently fails to update. The doc serializer escapes brackets the same
  // way, so this is the house convention rather than a new one.
  const named = { B: 'Dave [PM]' };

  it('drops the brackets so the tag stays a tag', () => {
    const md = renderSpeakerTag('B', named);
    expect(md).toBe('[@Dave PM](speaker:B)');
    expect(findSpeakerTags(md)).toHaveLength(1);
    expect(speakerLabelsIn(md)).toEqual(['B']);
  });

  it('still finds a tag an older build wrote with escapes in it', () => {
    // Nothing writes this shape any more, but a doc on disk may carry one,
    // and an unfindable tag is one no rename can ever reach again.
    const found = findSpeakerTags('- [@Dave \\[PM\\]](speaker:B) asked.');
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe('@Dave [PM]');
    expect(renameSpeakerTags('- [@Dave \\[PM\\]](speaker:B) asked.', 'B', named).replaced).toBe(1);
  });

  it('renames such a voice, where a raw-bracket tag renamed nothing at all', () => {
    const line = `- ${renderSpeakerTag('B', named)} asked.`;
    const out = renameSpeakerTags(line, 'B', { B: 'Dave Stillwater' });
    expect(out.replaced).toBe(1);
    expect(out.markdown).toBe('- [@Dave Stillwater](speaker:B) asked.');
  });

  it('leaves an already-canonical escaped tag exactly alone', () => {
    const md = renderSpeakerTag('B', named);
    const out = normalizeSpeakerTags(md, { names: named, known: new Set(['B']) });
    expect(out.markdown).toBe(md);
    expect(out.renamed).toBe(0);
  });

  it('takes an unknown voice out entirely — a tag whose text is all there was', () => {
    const md = renderSpeakerTag('C', { C: 'Dave [PM]' });
    const out = normalizeSpeakerTags(md, { names: {}, known: new Set(['B']) });
    expect(out.markdown).toBe('');
    expect(out.unknown).toEqual(['C']);
  });
});

describe('escapeTagText', () => {
  it('lets text a person typed survive a rebuild of the tag around it', () => {
    // The document rewriter holds visible text it did not compose. Raw, a
    // bracket closes the link early and the finder sees no tag at all.
    const text = '@Dave [PM]';
    expect(findSpeakerTags(`[${text}](speaker:B?t=10)`)).toHaveLength(0);
    const tags = findSpeakerTags(`[${escapeTagText(text)}](speaker:B?t=10)`);
    expect(tags).toHaveLength(1);
    // ...and the finder hands the text back exactly as the reader sees it.
    expect(tags[0]?.text).toBe(text);
    expect(tags[0]?.turns).toEqual([10]);
  });

  it('escapes a backslash too, so it cannot eat the bracket after it', () => {
    const text = '@Dave \\';
    const tags = findSpeakerTags(`[${escapeTagText(text)}](speaker:B)`);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.text).toBe(text);
  });
});

describe('normalizeSpeakerTags — the gate on what the model claims', () => {
  const known = new Set(['A', 'B']);

  it('re-renders a real voice from the name map rather than trusting the spelling', () => {
    const out = normalizeSpeakerTags('- [@mallory r](speaker:B) wants the gate moved.', {
      names: { B: 'Mallory' },
      known,
    });
    expect(out.markdown).toBe('- [@Mallory](speaker:B) wants the gate moved.');
    expect(out.renamed).toBe(1);
    expect(out.unknown).toEqual([]);
  });

  it('leaves a tag that is already canonical exactly as it is', () => {
    const md = '- [@Mallory](speaker:B) wants the gate moved.';
    const out = normalizeSpeakerTags(md, { names: { B: 'Mallory' }, known });
    expect(out.markdown).toBe(md);
    expect(out.renamed).toBe(0);
  });

  it('drops a voice the meeting never carried — NAME AND ALL — and reports the label', () => {
    // The name is the half a person reads. Unwrapping the link and leaving
    // "Trent" in the sentence removed the machine-readable claim and kept
    // the invented person, which is the failure this gate exists to stop.
    const out = normalizeSpeakerTags('- [@Trent](speaker:C) volunteered.', {
      names: {},
      known,
    });
    expect(out.markdown).toBe('- Volunteered.');
    expect(out.markdown).not.toContain('Trent');
    expect(out.unknown).toEqual(['C']);
  });

  it('leaves ordinary links untouched', () => {
    const md = '- Filed as [Move the gate](/w/w-1/t/t-1).';
    expect(normalizeSpeakerTags(md, { names: {}, known }).markdown).toBe(md);
  });

  it('leaves a line the person wrote byte for byte alone', () => {
    // The merge recognises a person's line by its exact text, and the
    // composer is asked to reproduce it verbatim. Normalizing it would make
    // the reproduction stop matching and land a second copy beside theirs.
    const mine = '- [@mallory r](speaker:B) — my own note, spelled my way';
    const out = normalizeSpeakerTags(`${mine}\n- [@mallory r](speaker:B) said it.`, {
      names: { B: 'Mallory' },
      known,
      protect: [mine.slice(2)],
    });
    expect(out.markdown.split('\n')[0]).toBe(mine);
    expect(out.markdown.split('\n')[1]).toBe('- [@Mallory](speaker:B) said it.');
  });
});

describe('renameSpeakerTags', () => {
  it('renames every mention of one voice and no mention of another', () => {
    const md =
      '- [@Speaker B](speaker:B) asked.\n- [@Speaker A](speaker:A) answered.\n- [@Speaker B](speaker:B) agreed.';
    const out = renameSpeakerTags(md, 'B', { B: 'Mallory' });
    expect(out.replaced).toBe(2);
    expect(out.markdown).toBe(
      '- [@Mallory](speaker:B) asked.\n- [@Speaker A](speaker:A) answered.\n- [@Mallory](speaker:B) agreed.',
    );
  });

  it('separates two voices a person has given the SAME name', () => {
    // The display-name rewrite this replaces could not do it: "Alice" in the
    // notes does not say which Alice, so renaming one would have moved the
    // other's words too. The label does say.
    const md = '- [@Alice](speaker:A) proposed it.\n- [@Alice](speaker:B) objected.';
    const out = renameSpeakerTags(md, 'A', { A: 'Alice Kelpbed', B: 'Alice' });
    expect(out.replaced).toBe(1);
    expect(out.markdown).toBe(
      '- [@Alice Kelpbed](speaker:A) proposed it.\n- [@Alice](speaker:B) objected.',
    );
  });

  it('does not touch prose that merely reads like the old name', () => {
    const md = '- Speaker B is who we mean by [@Speaker B](speaker:B).';
    expect(renameSpeakerTags(md, 'B', { B: 'Mallory' }).markdown).toBe(
      '- Speaker B is who we mean by [@Mallory](speaker:B).',
    );
  });

  it('is a no-op when the voice is already written that way', () => {
    const md = '- [@Mallory](speaker:B) asked.';
    expect(renameSpeakerTags(md, 'B', { B: 'Mallory' })).toEqual({ markdown: md, replaced: 0 });
  });
});

describe('provenance in the href', () => {
  it('carries the turns a mention was composed from, ascending and deduped', () => {
    expect(speakerTagHref('B', { turns: [12, 10, 10] })).toBe('speaker:B?t=10,12');
    expect(renderSpeakerTag('B', { B: 'Mallory' }, { turns: [10] })).toBe(
      '[@Mallory](speaker:B?t=10)',
    );
  });

  it('round-trips through the parser', () => {
    expect(parseSpeakerTagHref('speaker:B?t=10,12')).toEqual({
      label: 'B',
      turns: [10, 12],
      claimsTurns: true,
      unsure: false,
    });
    expect(parseSpeakerTagHref('speaker:B?t=10,12&unsure=1')).toEqual({
      label: 'B',
      turns: [10, 12],
      claimsTurns: true,
      unsure: true,
    });
  });

  it('still answers the only question most callers ask', () => {
    // The editor, the reassign menu and the doc rewrite all want the voice.
    // A tag an older build wrote has no parameters and must parse the same.
    expect(speakerTagLabel('speaker:B?t=10,12')).toBe('B');
    expect(speakerTagLabel('speaker:B')).toBe('B');
    expect(speakerTagLabel('/w/w-1/t/t-1')).toBeNull();
  });

  it('keeps the voice and drops the provenance when a parameter is unreadable', () => {
    // The safe direction: a mention whose provenance cannot be read is one
    // no revision can place, never one attributed to nobody.
    const ref = parseSpeakerTagHref('speaker:B?t=10,oops');
    expect(ref?.label).toBe('B');
    expect(ref?.turns).toEqual([]);
    // ...and it still says it CLAIMED provenance, which is what keeps the
    // next tick from filling the hole with turns of its own.
    expect(ref?.claimsTurns).toBe(true);
    expect(parseSpeakerTagHref('speaker:B')?.claimsTurns).toBe(false);
  });

  it('refuses to be unsure about nothing', () => {
    // The flag says the turns behind a mention disagree; with no turns
    // stamped there is nothing for it to mean.
    expect(speakerTagHref('B', { unsure: true })).toBe('speaker:B');
    expect(parseSpeakerTagHref('speaker:B?unsure=1')?.unsure).toBe(false);
  });

  it('stamps nothing past the cap, rather than a list nobody can act on', () => {
    const many = Array.from({ length: MAX_SPEAKER_TAG_TURNS + 1 }, (_, i) => i);
    expect(speakerTagHref('B', { turns: many })).toBe('speaker:B');
  });
});

describe('normalizeSpeakerTags — stamping this tick', () => {
  const known = new Set(['A', 'B']);

  it('stamps a tag the composer has just written with the tick that wrote it', () => {
    const out = normalizeSpeakerTags('- [@Mallory](speaker:B) wants the gate moved.', {
      names: { B: 'Mallory' },
      known,
      turnsByLabel: { B: [10, 12] },
    });
    expect(out.markdown).toBe('- [@Mallory](speaker:B?t=10,12) wants the gate moved.');
    expect(out.stamped).toBe(1);
    expect(out.renamed).toBe(0);
  });

  it('leaves provenance an earlier tick stamped exactly where it was', () => {
    // The composer returns the WHOLE notes every tick, so an old mention
    // comes back through this pass on every one. Restamping it would move
    // its provenance forward to words it was never written from.
    const md = '- [@Mallory](speaker:B?t=3) wants the gate moved.';
    const out = normalizeSpeakerTags(md, {
      names: { B: 'Mallory' },
      known,
      turnsByLabel: { B: [10, 12] },
    });
    expect(out.markdown).toBe(md);
    expect(out.stamped).toBe(0);
  });

  it('renames and keeps the provenance in one pass', () => {
    const out = normalizeSpeakerTags('- [@mallory r](speaker:B?t=3) said it.', {
      names: { B: 'Mallory' },
      known,
      turnsByLabel: { B: [10] },
    });
    expect(out.markdown).toBe('- [@Mallory](speaker:B?t=3) said it.');
    expect(out.renamed).toBe(1);
  });

  it('drops an invented voice whatever it claims to have been composed from', () => {
    const out = normalizeSpeakerTags('- [@Trent](speaker:C?t=10) volunteered.', {
      names: {},
      known,
    });
    expect(out.markdown).toBe('- Volunteered.');
    expect(out.unknown).toEqual(['C']);
  });

  it('does not fill a corrupted handle with turns from this tick', () => {
    // `t=3,oops` parses to no turns, the same empty list a bare tag has —
    // but it is an OLD mention whose handle broke, not a new one. Stamping
    // it here would hand the next revision a mention composed from words it
    // never saw, and move the wrong sentence.
    const md = '- [@Mallory](speaker:B?t=3,oops) wants the gate moved.';
    const out = normalizeSpeakerTags(md, {
      names: { B: 'Mallory' },
      known,
      turnsByLabel: { B: [10, 12] },
    });
    // The unreadable value goes, but the CLAIM stays, written as an empty
    // handle: this mention has no provenance and is never to be given any.
    expect(out.markdown).toBe('- [@Mallory](speaker:B?t=) wants the gate moved.');
    // Reported as neither a stamp nor a rename — it is a cleanup.
    expect(out.stamped).toBe(0);
    expect(out.renamed).toBe(0);
  });

  it('keeps the empty handle empty on every tick after that', () => {
    // The composer returns the whole notes each tick, so the canonical form
    // has to survive its own second pass — otherwise the mention is bare by
    // one tick and stamped by the next.
    const md = '- [@Mallory](speaker:B?t=) wants the gate moved.';
    const out = normalizeSpeakerTags(md, {
      names: { B: 'Mallory' },
      known,
      turnsByLabel: { B: [10, 12] },
    });
    expect(out.markdown).toBe(md);
    expect(out.stamped).toBe(0);
  });

  it('leaves that mention out of the correction that follows', () => {
    // The consequence of the rule above, end to end: turn 10 moves B to C,
    // and the mention whose provenance was unreadable stays with B because
    // it never got 10 stamped on it.
    const normalized = normalizeSpeakerTags(
      '- [@Mallory](speaker:B?t=3,oops) wants the gate moved.',
      {
        names: { B: 'Mallory' },
        known,
        turnsByLabel: { B: [10] },
      },
    ).markdown;
    const out = reattributeSpeakerTags(normalized, {
      revisions: revisions({ 10: 'C' }),
      names: { B: 'Mallory', C: 'Riverbend' },
    });
    expect(out.markdown).toBe(normalized);
    expect(out.moved).toBe(0);
  });
});

describe('reattributeSpeakerTags — the engine changes its mind late', () => {
  const names = { B: 'Mallory', C: 'Riverbend' };

  it('moves a mention whose every turn moved the same way', () => {
    const md = '- [@Mallory](speaker:B?t=10,12) wants the gate moved.';
    const out = reattributeSpeakerTags(md, {
      revisions: revisions({ 10: 'C', 12: 'C' }),
      names,
    });
    expect(out.markdown).toBe('- [@Riverbend](speaker:C?t=10,12) wants the gate moved.');
    expect(out.moved).toBe(1);
    expect(out.unsure).toBe(0);
  });

  it('takes the claim off — name included — when the words are attributed to nobody', () => {
    // A voice the engine has withdrawn its words from is a phantom by the
    // same arithmetic as one it never had, and gets the same remedy: the
    // note keeps its words, the meeting keeps no name against them.
    const out = reattributeSpeakerTags('- [@Mallory](speaker:B?t=10) asked about staging.', {
      revisions: revisions({ 10: null }),
      names,
    });
    expect(out.markdown).toBe('- Asked about staging.');
    expect(out.markdown).not.toContain('Mallory');
    expect(out.unwrapped).toBe(1);
  });

  it('marks a mention it cannot place instead of guessing', () => {
    // Turn 10 is still B and turn 12 is now C, so this mention belongs to
    // one of them and the notes do not record which.
    const out = reattributeSpeakerTags('- [@Mallory](speaker:B?t=10,12) wants the gate moved.', {
      revisions: revisions({ 12: 'C' }),
      names,
    });
    expect(out.markdown).toBe('- [@Mallory](speaker:B?t=10,12&unsure=1) wants the gate moved.');
    expect(out.unsure).toBe(1);
    expect(out.moved).toBe(0);
  });

  it('says nothing more about a mention already marked unsure', () => {
    const md = '- [@Mallory](speaker:B?t=10,12&unsure=1) wants the gate moved.';
    const out = reattributeSpeakerTags(md, { revisions: revisions({ 12: 'C' }), names });
    expect(out.markdown).toBe(md);
    expect(out.unsure).toBe(0);
  });

  it('leaves a mention no turn of which was revised', () => {
    const md = '- [@Mallory](speaker:B?t=10) wants the gate moved.';
    expect(reattributeSpeakerTags(md, { revisions: revisions({ 44: 'C' }), names }).markdown).toBe(
      md,
    );
  });

  it("leaves a person's own reassignment alone — it carries no provenance", () => {
    // `applyReassign` writes a bare `speaker:C`. A human answer is not a
    // guess the engine gets to revisit.
    const md = '- [@Riverbend](speaker:C) wants the gate moved.';
    expect(
      reattributeSpeakerTags(md, { revisions: revisions({ 10: 'B', 12: 'B' }), names }).markdown,
    ).toBe(md);
  });

  it('leaves every other voice in the same line alone', () => {
    const md = '- [@Mallory](speaker:B?t=10) agreed with [@Riverbend](speaker:C?t=11).';
    const out = reattributeSpeakerTags(md, { revisions: revisions({ 10: 'C' }), names });
    expect(out.markdown).toBe(
      '- [@Riverbend](speaker:C?t=10) agreed with [@Riverbend](speaker:C?t=11).',
    );
    expect(out.moved).toBe(1);
  });

  it('keeps two voices with the same name apart, because identity is the label', () => {
    // Both Alexes answer to "Alice". Only the mention whose turn moved is
    // touched, and it takes the OTHER label rather than the other spelling.
    const both = { A: 'Alice', B: 'Alice' };
    const md = '- [@Alice](speaker:A?t=10) proposed it.\n- [@Alice](speaker:B?t=11) objected.';
    const out = reattributeSpeakerTags(md, { revisions: revisions({ 10: 'B' }), names: both });
    expect(out.markdown).toBe(
      '- [@Alice](speaker:B?t=10) proposed it.\n- [@Alice](speaker:B?t=11) objected.',
    );
    expect(out.moved).toBe(1);
    // And the two are still separable afterwards: renaming B alone finds
    // both mentions of B and leaves A's untouched.
    const renamed = renameSpeakerTags(out.markdown, 'B', { A: 'Alice', B: 'Alice Lighthouse' });
    expect(renamed.replaced).toBe(2);
    expect(renamed.markdown).toBe(
      '- [@Alice Lighthouse](speaker:B?t=10) proposed it.\n- [@Alice Lighthouse](speaker:B?t=11) objected.',
    );
  });

  it('a rename carries provenance and the unsure flag through untouched', () => {
    const md = '- [@Speaker B](speaker:B?t=10,12&unsure=1) asked.';
    expect(renameSpeakerTags(md, 'B', { B: 'Mallory' }).markdown).toBe(
      '- [@Mallory](speaker:B?t=10,12&unsure=1) asked.',
    );
  });
});
