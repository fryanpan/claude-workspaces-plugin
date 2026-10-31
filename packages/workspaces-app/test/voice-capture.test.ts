/**
 * The origin gate every mic on the app shares: whether this page can open the
 * microphone, and the one URL to suggest when it cannot.
 */
import { describe, expect, it } from 'vitest';
import { type OriginFacts, insecureOriginMessage, localhostUrlFor } from '../src/voice-capture.ts';

/**
 * The origin gate (the "voice is just broken" report).
 *
 * The server is reached over plain http at a hostname, which is NOT a secure
 * context: Chrome keeps the `SpeechRecognition` constructor on the page but
 * refuses `start()` with `not-allowed` and never prompts. Verified in Chrome
 * 151 against the real origin — `isSecureContext: false`,
 * `navigator.mediaDevices === undefined`, `start()` → `not-allowed` → `end`.
 *
 * So the message must NOT tell anyone to allow the mic for the site — an
 * insecure origin has no such permission to grant — and must name an origin
 * that actually works.
 */
const insecureHostOrigin: OriginFacts = {
  isSecureContext: false,
  protocol: 'http:',
  hostname: 'host.example.ts.net',
  port: '8787',
  pathname: '/workspaces/w-1',
  search: '',
};

describe('localhostUrlFor', () => {
  it('rewrites an insecure host origin to the same page on loopback', () => {
    expect(localhostUrlFor(insecureHostOrigin)).toBe('http://localhost:8787/workspaces/w-1');
  });

  it('keeps the query string, so the suggested URL opens the same view', () => {
    expect(localhostUrlFor({ ...insecureHostOrigin, search: '?tab=tasks' })).toBe(
      'http://localhost:8787/workspaces/w-1?tab=tasks',
    );
  });

  it('has nothing to suggest when the page is already on loopback', () => {
    expect(localhostUrlFor({ ...insecureHostOrigin, hostname: 'localhost' })).toBeNull();
    expect(localhostUrlFor({ ...insecureHostOrigin, hostname: '127.0.0.1' })).toBeNull();
  });
});

describe('insecureOriginMessage', () => {
  // Positive control: the function CAN return null, so the assertions below
  // that expect a message are not vacuously true.
  it('is null on a secure origin', () => {
    expect(
      insecureOriginMessage({ ...insecureHostOrigin, isSecureContext: true, protocol: 'https:' }),
    ).toBeNull();
  });

  it('is null on plain-http loopback, which IS a secure context', () => {
    expect(
      insecureOriginMessage({
        ...insecureHostOrigin,
        hostname: 'localhost',
        isSecureContext: true,
      }),
    ).toBeNull();
  });

  it('names the loopback URL that actually works', () => {
    expect(insecureOriginMessage(insecureHostOrigin)).toContain(
      'http://localhost:8787/workspaces/w-1',
    );
  });

  it('never advises allowing the mic for the site — there is no such permission here', () => {
    const msg = insecureOriginMessage(insecureHostOrigin);
    // Assert the presence before the absence: an absence checked against a
    // null message would pass for the wrong reason.
    expect(msg).not.toBeNull();
    expect((msg ?? '').toLowerCase()).not.toContain('allow the mic');
  });
});
