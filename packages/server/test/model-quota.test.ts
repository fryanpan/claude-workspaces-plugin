/**
 * Telling a quota refusal from every other refusal, and saying so without
 * repeating anything the refusal's body said.
 *
 * All bodies here are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  QUOTA_PHRASES,
  QUOTA_REFUSAL_MARK,
  isQuotaFailure,
  isQuotaRefusal,
  quotaPhrase,
  refusalMessage,
} from '../src/model-quota.ts';

describe('isQuotaRefusal', () => {
  it('reads a 429 as quota whatever the body says', () => {
    expect(isQuotaRefusal(429, '')).toBe(true);
    expect(isQuotaRefusal(429, '{"error":{"message":"slow down"}}')).toBe(true);
  });

  it('reads a 400 whose body names the account as quota', () => {
    const body =
      '{"error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}';
    expect(isQuotaRefusal(400, body)).toBe(true);
    expect(isQuotaRefusal(400, '{"error":{"message":"monthly usage limit reached"}}')).toBe(true);
  });

  it('reads a 400 about the request itself as an ordinary failure', () => {
    const body = '{"error":{"type":"invalid_request_error","message":"model: unknown model"}}';
    expect(isQuotaRefusal(400, body)).toBe(false);
  });

  it('does not guess at a 400 whose body could not be read', () => {
    expect(isQuotaRefusal(400, '')).toBe(false);
  });

  it('leaves every other status alone', () => {
    expect(isQuotaRefusal(500, 'quota')).toBe(false);
    expect(isQuotaRefusal(401, 'credit balance')).toBe(false);
  });
});

describe('refusalMessage', () => {
  it('marks a quota refusal so the caller that reacts can find it', () => {
    const msg = refusalMessage('notes compose', 429, '');
    expect(isQuotaFailure(msg)).toBe(true);
    expect(msg).toContain('429');
    expect(msg).toContain(QUOTA_REFUSAL_MARK);
  });

  it('leaves an ordinary refusal unmarked', () => {
    const msg = refusalMessage('notes compose', 500, 'gateway');
    expect(isQuotaFailure(msg)).toBe(false);
    expect(msg).toContain('500');
  });

  it('never repeats the refusal body — a body can echo the request', () => {
    // The stand-in is a value-shaped string a real echo could carry. If any
    // part of the body reached the message, a log or a doc would carry it.
    //
    // THE PHRASE IS THE ONE THING THE MESSAGE MAY CARRY, and the property that
    // makes it safe is that it comes off OUR list — the body chooses it, never
    // supplies it. That is asserted HERE, on the function that emits the
    // message, and not only on `quotaPhrase`, which chooses it: a
    // `refusalMessage` that sliced the matched text out of the body satisfies
    // every membership case written against the other function, and reads as
    // equivalent to anyone skimming it.
    //
    // WHICH IS WHY THE BODY SAYS `Usage Limit` AND OUR CONSTANT SAYS
    // `usage limit`. Against an all-lowercase body a slice and a constant are
    // the same string and no assertion could tell them apart; the difference
    // in case is what makes the property observable at all.
    const body =
      '{"error":{"message":"Monthly Usage Limit reached","request":{"x-api-key":"NOT-A-REAL-VALUE-3f9c"}}}';
    const msg = refusalMessage('notes compose', 400, body);
    expect(isQuotaFailure(msg)).toBe(true);
    expect(msg).not.toContain('NOT-A-REAL-VALUE-3f9c');
    expect(msg).not.toContain('x-api-key');
    expect(msg).not.toContain('Monthly');
    expect(msg).not.toContain('Usage Limit');

    const named = /\(([^)]*)\)/.exec(msg);
    expect(named).not.toBeNull();
    const phrases: readonly string[] = QUOTA_PHRASES;
    expect(phrases).toContain((named as RegExpExecArray)[1]);
  });

  it('names which phrase classified it, so three failures stop reading alike', () => {
    const capped = refusalMessage(
      'notes compose',
      400,
      '{"error":{"message":"Your credit balance is too low"}}',
    );
    const limited = refusalMessage(
      'notes compose',
      400,
      '{"error":{"message":"monthly usage limit reached"}}',
    );
    // Same mark — both are the account — but a reader can now tell a top-up
    // from a cap, which was the whole complaint.
    expect(isQuotaFailure(capped)).toBe(true);
    expect(isQuotaFailure(limited)).toBe(true);
    expect(capped).toContain('credit balance');
    expect(limited).toContain('usage limit');
    expect(capped).not.toBe(limited);
  });

  it('names no phrase when the status classified it alone', () => {
    // A 429 is quota by status; no phrase chose it, so none is named — and
    // the message carries no empty parentheses standing in for one.
    //
    // Asserted as "the message STOPS at the mark" rather than "no phrase
    // appears in it": the mark itself contains `quota`, which is also one of
    // the phrases, so a search would answer true for a message that named
    // nothing.
    const msg = refusalMessage('notes compose', 429, '');
    expect(isQuotaFailure(msg)).toBe(true);
    expect(msg).not.toContain('(');
    expect(msg.endsWith(QUOTA_REFUSAL_MARK)).toBe(true);
  });
});

describe('quotaPhrase', () => {
  it('answers with one of our own phrases, not with the body', () => {
    const phrase = quotaPhrase(400, '{"error":{"message":"Your credit balance is too low"}}');
    // Membership, not equality to a slice of the body: what makes the value
    // safe to log is that it came off this list.
    expect(QUOTA_PHRASES).toContain(phrase as (typeof QUOTA_PHRASES)[number]);
    expect(phrase).toBe('credit balance');
  });

  it('answers null — not an empty string — when nothing matched', () => {
    expect(quotaPhrase(400, '{"error":{"message":"model: unknown model"}}')).toBeNull();
    expect(quotaPhrase(400, '')).toBeNull();
  });

  it('answers null for a status that classifies itself', () => {
    // The 429 body says "rate limit" and is still not read: the status has
    // already named the family.
    expect(quotaPhrase(429, '{"error":{"message":"rate limit exceeded"}}')).toBeNull();
    expect(quotaPhrase(500, 'quota')).toBeNull();
  });

  it('reports the first phrase in list order when a body names two', () => {
    const both = '{"error":{"message":"spend limit reached; quota exhausted"}}';
    expect(quotaPhrase(400, both)).toBe('quota');
  });
});
