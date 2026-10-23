import { describe, expect, it } from 'vitest';
import {
  clampEmbedHeight,
  embedFrameSpec,
  embedOriginsFrom,
  embedOriginsFromJson,
  embedUrl,
  parseBoardEmbeds,
  parseEmbedDirective,
} from './board-embeds.ts';

const EMBEDS = { sfworks: { appDocId: 'd-app1', pathTemplate: '{mount}/embed/bike/{block}/' } };
const ORIGIN = 'https://harborlight.example';
const AT_ORIGIN = { sfworks: { origin: ORIGIN, pathTemplate: '{origin}/embed/bike/{block}/' } };

describe('parseEmbedDirective', () => {
  it('reads the block of a whole-paragraph directive', () => {
    expect(parseEmbedDirective('::sfworks{block="goal-chart"}')).toEqual({
      name: 'sfworks',
      block: 'goal-chart',
    });
  });
  it('refuses a block outside the safe alphabet, and any prose around it', () => {
    expect(parseEmbedDirective('::sfworks{block="../x"}')).toBeNull();
    expect(parseEmbedDirective('::sfworks{block="A"}')).toBeNull();
    expect(parseEmbedDirective('see ::sfworks{block="a"}')).toBeNull();
    expect(parseEmbedDirective('::sfworks{src="a"}')).toBeNull();
  });
});

describe('embedUrl', () => {
  it('builds the mapped same-origin path from block alone', () => {
    expect(embedUrl(EMBEDS, 'w-1', 'sfworks', 'goal-chart')).toBe(
      '/workspaces/w-1/apps/d-app1/embed/bike/goal-chart/?cw-frame=1&cw-embed=1',
    );
  });
  it('answers null with no mapping or a bad block', () => {
    expect(embedUrl(null, 'w-1', 'sfworks', 'a')).toBeNull();
    expect(embedUrl(EMBEDS, 'w-1', 'other', 'a')).toBeNull();
    expect(embedUrl(EMBEDS, 'w-1', 'toString', 'a')).toBeNull();
    expect(embedUrl(EMBEDS, 'w-1', 'sfworks', 'a/b')).toBeNull();
  });
});

describe('an origin entry', () => {
  it('loads from the named origin, with no app-door parameters', () => {
    expect(embedFrameSpec(AT_ORIGIN, 'w-1', 'sfworks', 'goal-chart')).toEqual({
      url: 'https://harborlight.example/embed/bike/goal-chart/',
      origin: ORIGIN,
    });
    expect(embedFrameSpec(EMBEDS, 'w-1', 'sfworks', 'goal-chart')?.origin).toBeNull();
  });
  it('is stored only when its origin is on the allowlist', () => {
    expect(parseBoardEmbeds(AT_ORIGIN, [ORIGIN])).toEqual({ ok: true, embeds: AT_ORIGIN });
    expect(parseBoardEmbeds(AT_ORIGIN).ok).toBe(false);
    expect(parseBoardEmbeds(AT_ORIGIN, ['https://riverbend.example']).ok).toBe(false);
  });
  it('refuses both kinds at once, a path in the origin, and a template off the origin', () => {
    const allow = [ORIGIN];
    const bad = [
      { origin: ORIGIN, appDocId: 'd-app1', pathTemplate: '{origin}/x' },
      { origin: `${ORIGIN}/x`, pathTemplate: '{origin}/x' },
      { origin: ORIGIN, pathTemplate: '{mount}/x' },
      { origin: ORIGIN, pathTemplate: '{origin}@evil/x' },
      { origin: ORIGIN, pathTemplate: '{origin}/../x' },
      { appDocId: 'd-app1', pathTemplate: '{origin}/x' },
    ];
    for (const t of bad) expect(parseBoardEmbeds({ sfworks: t }, allow).ok).toBe(false);
  });
});

describe('embedOriginsFrom', () => {
  it('allows none when the deployment names none', () => {
    expect(embedOriginsFrom(undefined)).toEqual([]);
  });
  it('takes exact https origins and drops anything else', () => {
    expect(
      embedOriginsFrom(
        'https://harborlight.example, http://riverbend.example,https://*.x.example,https://saltmarsh.example/p,https://bob.example:8443',
      ),
    ).toEqual(['https://harborlight.example', 'https://bob.example:8443']);
    expect(embedOriginsFrom('')).toEqual([]);
  });
  it('reads the file as an array of origins, and anything else as none', () => {
    expect(embedOriginsFromJson(['https://harborlight.example', 'http://bob.example', 7])).toEqual([
      'https://harborlight.example',
    ]);
    expect(embedOriginsFromJson({ origins: ['https://harborlight.example'] })).toEqual([]);
    expect(embedOriginsFromJson(null)).toEqual([]);
  });
});

describe('parseBoardEmbeds', () => {
  it('accepts the sfworks mapping', () => {
    expect(parseBoardEmbeds(EMBEDS)).toEqual({ ok: true, embeds: EMBEDS });
  });
  it('refuses a template that leaves the mount or climbs out of it', () => {
    for (const pathTemplate of [
      'https://evil/{block}',
      '/x/{block}',
      '{mount}/../{block}',
      '{mount}?q={block}',
    ]) {
      expect(parseBoardEmbeds({ sfworks: { appDocId: 'd-app1', pathTemplate } }).ok).toBe(false);
    }
    expect(parseBoardEmbeds({ sfworks: { appDocId: '../x', pathTemplate: '{mount}/' } }).ok).toBe(
      false,
    );
    expect(parseBoardEmbeds({ Bad: EMBEDS.sfworks }).ok).toBe(false);
  });
});

it('clamps a height into range', () => {
  expect(clampEmbedHeight(5)).toBe(80);
  expect(clampEmbedHeight(4500)).toBe(4500);
  expect(clampEmbedHeight(99999)).toBe(10000);
  expect(clampEmbedHeight(321.4)).toBe(321);
});
