import { describe, expect, it } from 'vitest';
import {
  REVIEW_LIMITS,
  checkReviewPayload,
  isSecretServiceName,
  readReviewPayload,
  reviewGapAdvice,
} from './review-item.ts';

/** A well-formed ask, which each case below spoils in exactly one way. */
function ask(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    review_type: 'secret',
    headline: 'Add the Riverbend weather key',
    detail: 'The morning digest ships Monday and the forecast pull will not run without it.',
    secrets: [{ label: 'API key', service: 'riverbend-weather-key' }],
    ...over,
  };
}

describe('a secret ask passes the gate', () => {
  it('admits one field, and two', () => {
    expect(checkReviewPayload(ask()).ok).toBe(true);
    expect(
      checkReviewPayload(
        ask({
          secrets: [
            { label: 'API key', service: 'riverbend-weather-key' },
            { label: 'Webhook secret', service: 'riverbend-webhook-secret' },
          ],
        }),
      ).ok,
    ).toBe(true);
  });

  it('stores the fields and forces owner-only, whatever the caller said', () => {
    const read = readReviewPayload(ask());
    expect(read?.shape).toBe('secret');
    expect(read?.secrets).toEqual([{ label: 'API key', service: 'riverbend-weather-key' }]);
    expect(read?.ownerOnly).toBe(true);
  });

  it('forces owner-only on a payload stored before the rule existed', () => {
    // The stored spelling, with the flag absent — what a `.ydoc` written by an
    // older bundle holds. Read paths and the write path share this reader, so
    // the item comes back owner-only either way.
    const read = readReviewPayload({
      shape: 'secret',
      headline: 'Add the key',
      secrets: [{ label: 'API key', service: 'riverbend-weather-key' }],
    });
    expect(read?.ownerOnly).toBe(true);
  });

  it('never carries a value, however one is spelled into the payload', () => {
    const read = readReviewPayload(
      ask({ secrets: [{ label: 'API key', service: 'riverbend-weather-key', value: 'x' }] }),
    );
    expect(read?.secrets?.[0]).toEqual({ label: 'API key', service: 'riverbend-weather-key' });
    expect(JSON.stringify(read)).not.toContain('value');
  });
});

describe('what the gate refuses', () => {
  it('refuses a secret ask with no fields', () => {
    const check = checkReviewPayload(ask({ secrets: [] }));
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toContain('at least one entry in review.secrets');
  });

  it('refuses more fields than fit a phone', () => {
    const many = Array.from({ length: REVIEW_LIMITS.maxSecrets + 1 }, (_, i) => ({
      label: `Key ${i}`,
      service: `riverbend-key-${i}`,
    }));
    expect(checkReviewPayload(ask({ secrets: many })).ok).toBe(false);
  });

  it.each([
    ['a space', 'riverbend weather key'],
    ['a slash', 'riverbend/weather'],
    ['a leading dash that reads as a flag', '-w'],
    ['a shell metacharacter', 'riverbend;rm'],
    ['nothing at all', ''],
    ['65 characters', 'a'.repeat(65)],
  ])('refuses a service name holding %s', (_why, service) => {
    expect(checkReviewPayload(ask({ secrets: [{ label: 'API key', service }] })).ok).toBe(false);
    expect(isSecretServiceName(service)).toBe(false);
  });

  it('refuses two fields storing under one name', () => {
    const check = checkReviewPayload(
      ask({
        secrets: [
          { label: 'API key', service: 'riverbend-weather-key' },
          { label: 'Spare key', service: 'riverbend-weather-key' },
        ],
      }),
    );
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toContain('used twice');
  });

  it('refuses a field with no label', () => {
    expect(checkReviewPayload(ask({ secrets: [{ service: 'riverbend-weather-key' }] })).ok).toBe(
      false,
    );
  });

  it('refuses options on a secret ask', () => {
    const check = checkReviewPayload(
      ask({
        options: [
          { id: 'a', label: 'Yes' },
          { id: 'b', label: 'No' },
        ],
      }),
    );
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toContain('not a choice between anything');
  });

  it('refuses fields on an ask that is not a secret one', () => {
    const check = checkReviewPayload(ask({ review_type: 'question' }));
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toContain("belong to a 'secret' item");
  });
});

describe('what it only advises', () => {
  it('files a long label and says it will wrap', () => {
    const check = checkReviewPayload(
      ask({
        secrets: [
          { label: 'x'.repeat(REVIEW_LIMITS.secretLabelChars + 5), service: 'riverbend-key' },
        ],
      }),
    );
    expect(check.ok).toBe(true);
    expect(check.gaps).toContain('secretLabelLength');
    expect(reviewGapAdvice(check.gaps)).toContain('wraps away from the service name');
  });
});

describe('a decision is still a decision', () => {
  it('keeps refusing a one-option decision, which a one-field secret is not', () => {
    expect(
      checkReviewPayload({
        review_type: 'decision',
        headline: 'Ship it?',
        options: [{ id: 'a', label: 'Ship' }],
      }).ok,
    ).toBe(false);
  });
});
