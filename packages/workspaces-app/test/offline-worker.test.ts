/**
 * The page side of the offline worker (offline-worker.ts): it registers the
 * one root-scoped worker and names what this page loaded before the worker
 * could see it.
 */
import { describe, expect, it } from 'vitest';
import { loadedAppFiles, registerOfflineWorker } from '../src/offline-worker.ts';

describe('loadedAppFiles', () => {
  it('keeps same-origin /app/ paths only', () => {
    expect(
      loadedAppFiles(
        [
          'https://board.example/app/app-12345678.js',
          'https://board.example/api/auth/session',
          'https://cdn.example/app/x.js',
          'not a url',
        ],
        'https://board.example',
      ),
    ).toEqual(['/app/app-12345678.js']);
  });
});

describe('registerOfflineWorker', () => {
  it('registers /sw.js at root scope and posts keep-page once active', async () => {
    const posted: unknown[] = [];
    const registered: Array<[string, unknown]> = [];
    const active = { postMessage: (m: unknown) => void posted.push(m) };
    registerOfflineWorker({
      serviceWorker: {
        register: async (url, options) => void registered.push([url, options]),
        ready: Promise.resolve({ active }),
        controller: {},
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(registered).toEqual([['/sw.js', { scope: '/' }]]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'keep-page', shell: location.pathname });
  });

  it('posts again when the worker first takes the page over', async () => {
    const posted: unknown[] = [];
    let onChange: (() => void) | null = null;
    registerOfflineWorker({
      serviceWorker: {
        register: async () => {},
        ready: Promise.resolve({ active: { postMessage: (m: unknown) => void posted.push(m) } }),
        controller: null,
        addEventListener: (_t, fn) => {
          onChange = fn;
        },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    (onChange as (() => void) | null)?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toHaveLength(2);
  });

  it('a browser without service workers is left alone', () => {
    expect(() => registerOfflineWorker({})).not.toThrow();
  });
});
