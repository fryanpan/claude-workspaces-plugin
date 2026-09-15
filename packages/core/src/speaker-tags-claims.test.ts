/**
 * A tag keeps its turns only if the block it lands in already had them
 * (`claimsFrom`). The outline shows every tag's href, so a note-taker writing
 * a new note about a voice copies the turns of that voice's first mention.
 */
import { describe, expect, it } from 'vitest';
import { normalizeSpeakerTags } from './speaker-tags.ts';

describe('normalizeSpeakerTags — whose claim a copied tag is', () => {
  const known = new Set(['A', 'B']);

  it('restamps a claim a new note copied from another note', () => {
    // The outline shows every tag's href, so a new note about B arrives
    // carrying the turns of the note it was copied from. An insert held no
    // claims, so it gets this tick's turns.
    const out = normalizeSpeakerTags('- [@Devi](speaker:B?t=3) asks about the gate.', {
      names: { B: 'Devi' },
      known,
      turnsByLabel: { B: [10, 12] },
      claimsFrom: '',
    });
    expect(out.markdown).toBe('- [@Devi](speaker:B?t=10,12) asks about the gate.');
    expect(out.stamped).toBe(1);
  });

  it('keeps the claim a replaced note already carried', () => {
    const out = normalizeSpeakerTags('- [@Devi](speaker:B?t=3) wants the gate moved east.', {
      names: { B: 'Devi' },
      known,
      turnsByLabel: { B: [10, 12] },
      claimsFrom: '[@Devi](speaker:B?t=3) wants the gate moved.',
    });
    expect(out.markdown).toBe('- [@Devi](speaker:B?t=3) wants the gate moved east.');
    expect(out.stamped).toBe(0);
  });

  it('does not keep a claim for turns the replaced note never carried', () => {
    const out = normalizeSpeakerTags('- [@Devi](speaker:B?t=1) and it moved.', {
      names: { B: 'Devi' },
      known,
      turnsByLabel: { B: [10] },
      claimsFrom: '[@Devi](speaker:B?t=3) wants the gate moved.',
    });
    expect(out.markdown).toBe('- [@Devi](speaker:B?t=10) and it moved.');
  });

  it('keeps a claim only as many times as the replaced note carried it', () => {
    const out = normalizeSpeakerTags(
      '- [@Devi](speaker:B?t=3) wants the gate moved, and [@Devi](speaker:B?t=3) will ask.',
      {
        names: { B: 'Devi' },
        known,
        turnsByLabel: { B: [10] },
        claimsFrom: '[@Devi](speaker:B?t=3) wants the gate moved.',
      },
    );
    expect(out.markdown).toBe(
      '- [@Devi](speaker:B?t=3) wants the gate moved, and [@Devi](speaker:B?t=10) will ask.',
    );
  });
});
