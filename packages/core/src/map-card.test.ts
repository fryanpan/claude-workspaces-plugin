import { describe, expect, it } from 'vitest';
import { CARD_LINES, isWebHref, popupText, readPopup } from './map-card.ts';
import { readMapSpec } from './map-spec.ts';

describe('a map popup read as words or a card', () => {
  it('keeps words, a number as words, and nothing as nothing', () => {
    expect(readPopup('Harborlight hall', 'p')).toEqual({ ok: true, value: 'Harborlight hall' });
    expect(readPopup(412, 'p')).toEqual({ ok: true, value: '412' });
    expect(readPopup(undefined, 'p')).toEqual({ ok: true, value: undefined });
  });

  it('reads a card of a title, lines and one http(s) link', () => {
    expect(
      readPopup(
        {
          title: 'Harborlight school',
          lines: ['Riverbend district', 412],
          link: { href: 'https://example.org/harborlight', text: 'School page' },
        },
        'p',
      ),
    ).toEqual({
      ok: true,
      value: {
        title: 'Harborlight school',
        lines: ['Riverbend district', '412'],
        link: { href: 'https://example.org/harborlight', text: 'School page' },
      },
    });
  });

  it('refuses a link that is not http(s), and names where', () => {
    for (const href of [
      'javascript:alert(1)',
      ' data:text/html,x',
      '//example.org',
      'ftp://x',
      '',
    ]) {
      expect(readPopup({ link: { href } }, 'markers[0].popup')).toEqual({
        ok: false,
        error: 'markers[0].popup link.href must be an http(s) URL',
      });
    }
    expect(isWebHref('HTTP://example.org')).toBe(true);
    expect(isWebHref('https:// example.org')).toBe(false);
  });

  it('refuses a card it cannot draw as text', () => {
    expect(readPopup(['a'], 'p')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/text or a card/),
    });
    expect(readPopup({ title: { a: 1 } }, 'p')).toMatchObject({
      ok: false,
      error: 'p title must be text',
    });
    expect(readPopup({ lines: 'one' }, 'p')).toMatchObject({ ok: false });
    expect(readPopup({ lines: [{}] }, 'p')).toMatchObject({ ok: false });
    expect(readPopup({ lines: Array(CARD_LINES + 1).fill('x') }, 'p')).toMatchObject({ ok: false });
  });

  it('fills a template as text from the properties', () => {
    expect(
      popupText('{name}: {speed} mph{gone}', { name: 'Riverbend Ave', speed: 20, gone: {} }),
    ).toBe('Riverbend Ave: 20 mph');
  });
});

describe('a StreetMap spec with cards, tooltips and cooperative gestures', () => {
  it('carries a card and a tooltip on markers and points, and the gesture switch', () => {
    const out = readMapSpec({
      cooperativeGestures: true,
      markers: [
        { lat: 1, lng: 2, label: 'Alice', tooltip: 'Alice hall', popup: { title: 'Alice' } },
      ],
      points: [{ lat: 1, lng: 2, tooltip: 'Bob' }],
    });
    if (!out.ok) throw new Error(out.error);
    expect(out.spec.cooperativeGestures).toBe(true);
    expect(out.spec.markers[0]).toMatchObject({ tooltip: 'Alice hall', popup: { title: 'Alice' } });
    expect(out.spec.points[0]?.tooltip).toBe('Bob');
    const plain = readMapSpec({ markers: [{ lat: 1, lng: 2 }] });
    expect(plain.ok && plain.spec.cooperativeGestures).toBe(false);
  });

  it('refuses a marker or point card with a link that is not http(s), naming the row', () => {
    expect(
      readMapSpec({ markers: [{ lat: 1, lng: 2, popup: { link: { href: 'javascript:x' } } }] }),
    ).toEqual({ ok: false, error: expect.stringContaining('markers[0].popup link.href') });
    expect(
      readMapSpec({
        points: [
          { lat: 1, lng: 2 },
          { lat: 1, lng: 2, popup: { link: { href: 'vbscript:x' } } },
        ],
      }),
    ).toEqual({ ok: false, error: expect.stringContaining('points[1].popup link.href') });
  });
});
