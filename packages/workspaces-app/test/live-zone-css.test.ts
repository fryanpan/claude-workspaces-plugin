import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COLLAPSE_MS, FADE_MS } from '../src/meeting-live-zone.ts';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The live zone's stylesheet contract (meeting-live-zone.ts).
 *
 * happy-dom lays nothing out, so what the browser measurement in the PR proves
 * — the transcript's first line within one prose line-height of the doc's last
 * line — is guarded here by the two declarations that produce it: the zone
 * brings no top margin of its own (the paragraph's bottom margin is the whole
 * gap), and the label floats into the corner instead of taking a row above the
 * words.
 *
 * Those two are read off the CASCADE now rather than out of the file's text. A
 * regex for `margin:` found the declaration wherever it sat and said nothing
 * about whether it survived to the element — a `margin-top` added later, or on
 * a compound selector, would have left the old test green and the gap back.
 *
 * SHEETS: the review shell links `styles.css` (then `tokens.css`, left out
 * here — the served file is a vendored Open Props subset plus `src/tokens.css`,
 * and the mapping half alone re-points every remapped token at an undefined
 * `var(--gray-N)`).
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('styles.css', 'doc.css');
  setViewport(IPAD);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('the transcript starts on the next line down from the doc', () => {
  it('the zone adds no top margin of its own', () => {
    const zone = styleOf(attach('live-zone'));
    // Positive control first: an element the cascade never reaches reads ''
    // for margin-top too, which would satisfy the assertion below by
    // measuring nothing.
    expect(zone.padding).toBe('2px 0px 8px');
    expect(zone.marginTop).toBe('0px');
  });

  it('the zone brings no frame and no side padding, so it shares the notes’ left edge', () => {
    const zone = styleOf(attach('live-zone'));
    // The dashed border and the panel fill are gone with the approved mock
    // (round 2); the side padding they took went with them, which is
    // what puts the transcript on the same left edge as the notes.
    expect(zone.paddingLeft).toBe('0px');
    expect(zone.paddingRight).toBe('0px');
    expect(zone.borderStyle === 'none' || zone.borderStyle === '').toBe(true);
    expect(zone.background).toBe('transparent'); // control: the rule is live
  });

  it('the transcript is smaller and greyer than the notes it feeds', () => {
    const prose = attach('ProseMirror', { parent: attach('', { attrs: { id: 'editor' } }) });
    const notes = styleOf(attach('', { tag: 'p', parent: prose }));
    const zone = attach('live-zone');
    const size = (el: Element): number => Number.parseFloat(styleOf(el).fontSize);
    const colour = (el: Element): string => styleOf(el).color;
    for (const cls of ['lz-lines', 'lz-chunk-lines']) {
      const el = attach(cls, { parent: zone });
      expect(size(el), cls).toBeLessThan(Number.parseFloat(notes.fontSize));
      // Greyer: the zone's own `--lz-fg`, not the notes' `--fg`. It used to
      // pin `--fg-muted`'s hex here; the transcript left that token when it
      // had to clear 7:1 in a bright room, and the ratio that replaced the
      // hex is asserted below, against the ground rather than on its own.
      expect(colour(el), cls).not.toBe(colour(prose));
      expect(colour(el), cls).toBe('#4b535c');
    }
  });

  it('the transcript steps down with the notes at phone width', () => {
    // Read the pair at one viewport and drop the nodes: `styleOf` hands back
    // a LIVE declaration, so a value held across `setViewport` re-answers for
    // the new width and would compare the phone against itself.
    const read = (): { notes: number; lines: number; chunk: number; leading: string } => {
      const editor = attach('', { attrs: { id: 'editor' } });
      const prose = attach('ProseMirror', { parent: editor });
      const notes = Number.parseFloat(styleOf(attach('', { tag: 'p', parent: prose })).fontSize);
      const zone = attach('live-zone', { parent: editor });
      const lines = Number.parseFloat(styleOf(attach('lz-lines', { parent: zone })).fontSize);
      const chunkStyle = styleOf(attach('lz-chunk lz-chunk-lines', { parent: zone }));
      const chunk = Number.parseFloat(chunkStyle.fontSize);
      const leading = chunkStyle.lineHeight;
      document.body.replaceChildren();
      return { notes, lines, chunk, leading };
    };

    setViewport(IPAD);
    const wide = read();
    setViewport(PHONE);
    const phone = read();

    // Controls first, and the second one is the one that matters: the notes
    // drop to 16px at `max-width: 720px` in styles.css whatever this sheet
    // does, so a harness that never evaluated the media query would fail
    // HERE rather than passing the assertions below by accident.
    expect(wide.notes).toBe(18);
    expect(phone.notes).toBe(16);

    // The transcript rides the notes' own breakpoint. Left on its own 15px it
    // would sit 1px under 16px notes on a phone, and the size half of
    // "smaller and greyer" would stop being legible as a distinction.
    expect(wide.lines).toBe(15);
    expect(phone.lines).toBe(14);
    expect(phone.chunk).toBe(14); // the split-off chunk is the same text
    expect(phone.leading).not.toBe(wide.leading);

    // What the two readings are actually for: the gap survives the step down.
    expect(wide.notes - wide.lines).toBe(3);
    expect(phone.notes - phone.lines).toBe(2);
  });

  it('the label floats into the corner rather than taking a row above the words', () => {
    const head = styleOf(attach('lz-head', { parent: attach('live-zone') }));
    expect(head.float).toBe('right');
    expect(head.display).toBe('flex'); // control: the rule is live
  });

  it('the split-off chunk has nothing drawn around it, and is not positioned', () => {
    const chunk = styleOf(attach('lz-chunk lz-chunk-lines', { parent: attach('live-zone') }));
    // Control that the rule is live, and the whole point of it: the chunk
    // fades, and that transition is the only thing it adds.
    expect(chunk.transition).toContain('opacity');
    // No card any more — no border, no fill, no padding of its own, so the
    // words land on the pixels they were already on when they split off.
    expect(chunk.borderLeftWidth).toBe('0px');
    expect(chunk.background).toBe('transparent');
    expect(chunk.padding).toBe('0px');
    // Unpositioned, so it cannot paint over the floated corner label.
    expect(chunk.position === 'static' || chunk.position === '').toBe(true);
  });

  it('the fade and the collapse are two beats, and the sheet agrees with the module', () => {
    const zone = attach('live-zone');
    const vars = styleOf(zone);
    // meeting-live-zone.ts waits these out between beats; the transitions are
    // here. A pair that drifts apart is a chunk removed mid-animation.
    expect(vars.getPropertyValue('--lz-fade-ms').trim()).toBe(`${FADE_MS}ms`);
    expect(vars.getPropertyValue('--lz-collapse-ms').trim()).toBe(`${COLLAPSE_MS}ms`);

    // The fade is opacity only — nothing that could move a word. (happy-dom
    // does not expand the shorthand, so the shorthand is what is read.)
    const chunk = styleOf(attach('lz-chunk lz-chunk-lines', { parent: zone }));
    expect(chunk.transition).toBe(`opacity ${FADE_MS}ms ease-out`);
    expect(styleOf(attach('lz-chunk lz-chunk-lines is-fading', { parent: zone })).opacity).toBe(
      '0',
    );

    // The collapse is height only, and it is withheld until the class lands:
    // an always-on `overflow: hidden` would make the slot a block formatting
    // context, which refuses to sit beside the floated label.
    expect(styleOf(attach('lz-slot', { parent: zone })).overflow).not.toBe('hidden');
    const collapsing = styleOf(attach('lz-slot is-collapsing', { parent: zone }));
    expect(collapsing.overflow).toBe('hidden');
    expect(collapsing.transition).toContain('height');
    expect(collapsing.transition).toContain(`${COLLAPSE_MS}ms`);
  });

  it('the spinner and its "writing" line are gone from the sheet too', () => {
    const zone = attach('live-zone');
    // Their rules going with the markup is what keeps a stray class from
    // resurrecting the box that shifted the words (owner, 2026-09-05).
    // Read on a span, whose UA default display is inline and reads '' here:
    // a div reads 'block' from the UA sheet whether a rule matched or not.
    for (const dead of ['lz-chunk-note', 'lz-spinner']) {
      const el = styleOf(attach(dead, { tag: 'span', parent: zone }));
      expect(el.display, dead).toBe('');
      expect(el.animation, dead).toBe('');
      expect(el.width, dead).toBe('');
    }
    // Control that this file can see a rule at all on that same chain.
    expect(styleOf(attach('lz-turn', { tag: 'span', parent: zone })).display).toBe('inline');
  });

  it('turns are inline and the stream has no per-turn block rule left', () => {
    const zone = attach('live-zone');
    // The one rule that must be there: a turn is a span in a run of text.
    expect(styleOf(attach('lz-turn', { tag: 'span', parent: zone })).display).toBe('inline');
    // …and the two classes the per-line layout used to own are unstyled, so a
    // span carrying them stays in the run rather than opening a block. A
    // reintroduced `display: block` on either would show up right here.
    for (const dead of ['lz-line', 'lz-ts']) {
      const el = styleOf(attach(dead, { tag: 'span', parent: zone }));
      expect(el.display, dead).toBe('');
      expect(el.margin, dead).toBe('');
    }
  });
});

/**
 * The hold that keeps the stream still across a split (meeting-live-zone.ts,
 * `holdStreamAt`). Lifting the composing turns into a block ends the line
 * they shared with the words still being spoken, and the stream would drop to
 * the next line and jump back to the margin — 23.25px and 112.88px, measured
 * in Chrome at 1180x820. The zone measures that displacement and hands it
 * back as these two custom properties; what is guarded here is that they
 * reach the stream at all, and that letting go of them is a transition rather
 * than a snap.
 */
describe('the stream is held over the break a split makes in its line', () => {
  it('the two offsets reach the stream as a margin and a first-line indent', () => {
    const lines = attach('lz-lines', { parent: attach('live-zone') });
    // Unset they are nothing, and this rule reads exactly as the `margin: 0`
    // above it — a zone that never splits is not paying for the hold.
    expect(styleOf(lines).marginTop).toBe('0px');
    expect(styleOf(lines).textIndent).toBe('0px');

    lines.style.setProperty('--lz-hold-y', '-23.25px');
    lines.style.setProperty('--lz-hold-x', '112.88px');
    expect(styleOf(lines).marginTop).toBe('-23.25px');
    expect(styleOf(lines).textIndent).toBe('112.88px');
  });

  it('letting go runs on the collapse’s own duration, so the stream travels once', () => {
    const zone = attach('live-zone');
    // Held, nothing transitions: the settle pins the slot's height precisely
    // so that nothing moves between the split and the collapse.
    expect(styleOf(attach('lz-lines', { parent: zone })).transition).toBe('');

    const releasing = styleOf(attach('lz-lines is-releasing', { parent: zone }));
    expect(releasing.transition).toContain('margin-top');
    expect(releasing.transition).toContain('text-indent');
    // The same number the slot's own height collapses over — one motion.
    expect(releasing.transition).toContain(`${COLLAPSE_MS}ms`);
  });
});

/**
 * Contrast (owner, 2026-09-06: the transcript has to be readable on an iPad
 * in a bright room). The words being read are not a readout glanced at: they
 * carry their own colour, one step darker than `--fg-muted`, and they are
 * still marked secondary by TYPE alone — no frame comes back for it.
 *
 * The ratio is computed here rather than asserted as a hex, because a hex
 * says nothing about what it sits on: repointing the ground would leave a
 * colour assertion green and the text unreadable.
 */
describe('the transcript is readable in a bright room', () => {
  /** A computed colour as channels. happy-dom answers `#rrggbb` where a
   *  browser answers `rgb(r, g, b)`; both shapes turn up, so both parse. */
  const toRgb = (css: string): [number, number, number] => {
    const hex = css.trim().match(/^#([0-9a-f]{6})$/i);
    if (hex?.[1]) {
      const n = Number.parseInt(hex[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const parts = (css.match(/\d+(?:\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    if (parts.length < 3) throw new Error(`not a colour: ${css}`);
    return parts as [number, number, number];
  };

  /** WCAG relative luminance. */
  const luminance = (css: string): number => {
    const [r, g, b] = toRgb(css);
    const lin = (c: number): number => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const contrast = (fg: string, bg: string): number => {
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  /** The transcript's colour and the ground the page paints behind it. */
  const measure = (): { text: string; ground: string; prose: string } => {
    const editor = attach('', { attrs: { id: 'editor' } });
    const prose = attach('ProseMirror', { parent: editor });
    const note = attach('', { tag: 'p', parent: prose });
    const lines = attach('lz-lines', { parent: attach('live-zone', { parent: editor }) });
    return {
      text: styleOf(lines).color,
      ground: styleOf(document.body).backgroundColor,
      prose: styleOf(note).color,
    };
  };

  for (const [name, viewport] of [
    ['tablet', IPAD],
    ['phone', PHONE],
  ] as const) {
    it(`clears 7:1 against the ground the page paints, at ${name} width`, () => {
      setViewport(viewport);
      const { text, ground, prose } = measure();
      // Control: the sheets are installed and the ground is the real one, so
      // the ratio below is a measurement rather than two unset strings.
      expect(toRgb(ground)).toEqual([255, 255, 255]);
      expect(contrast(text, ground)).toBeGreaterThanOrEqual(7);
      // …and still plainly secondary to the notes it feeds: darker would be
      // an improvement on the number and a regression on the design.
      expect(contrast(prose, ground)).toBeGreaterThan(contrast(text, ground));
    });
  }

  it('the speaker pill is read with the words, so it carries their colour', () => {
    setViewport(IPAD);
    const zone = attach('live-zone');
    const lines = attach('lz-lines', { parent: zone });
    const pill = attach('lz-speaker', { tag: 'span', parent: lines });
    expect(styleOf(pill).color).toBe(styleOf(lines).color);
  });

  it('nothing framed came back for the contrast', () => {
    setViewport(IPAD);
    const zone = styleOf(attach('live-zone'));
    expect(zone.background).toBe('transparent');
    expect(zone.borderStyle === 'none' || zone.borderStyle === '').toBe(true);
    expect(zone.boxShadow === 'none' || zone.boxShadow === '').toBe(true);
  });
});
