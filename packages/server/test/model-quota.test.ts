/**
 * Telling a quota refusal from every other refusal, and saying so without
 * repeating anything the refusal's body said.
 *
 * All bodies here are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  QUOTA_REFUSAL_MARK,
  isQuotaFailure,
  isQuotaRefusal,
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
    const body =
      '{"error":{"message":"usage limit","request":{"x-api-key":"NOT-A-REAL-VALUE-3f9c"}}}';
    const msg = refusalMessage('notes compose', 400, body);
    expect(isQuotaFailure(msg)).toBe(true);
    expect(msg).not.toContain('NOT-A-REAL-VALUE-3f9c');
    expect(msg).not.toContain('x-api-key');
    expect(msg).not.toContain('usage limit');
  });
});
