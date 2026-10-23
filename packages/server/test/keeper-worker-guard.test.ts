import { describe, expect, it } from 'bun:test';
import { workerEvidence } from '../src/keeper/keeper-worker-guard.ts';

const req = (headers: Record<string, string>) =>
  new Request('http://localhost:8797/approve/abc', { headers });

describe('workerEvidence', () => {
  it('names a worker script fetch and a navigation a worker passed on', () => {
    expect(workerEvidence(req({ 'service-worker': 'script' }))).toContain('script at /approve/abc');
    expect(
      workerEvidence(req({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'empty' })),
    ).toContain('passed on a navigation');
    expect(
      workerEvidence(
        req({
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'empty',
        }),
      ),
    ).toContain('fetched the page /approve/abc');
  });

  it("finds nothing in the browser's own navigation, a page's fetch, or curl", () => {
    // Headers measured from headless Chrome's own navigation and the page's fetch.
    for (const headers of [
      { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1' },
      { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' },
      {
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'sec-fetch-site': 'same-origin',
      },
      { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image', 'sec-fetch-site': 'cross-site' },
      {},
    ]) {
      expect({ headers, found: workerEvidence(req(headers)) }).toEqual({ headers, found: null });
    }
  });
});
