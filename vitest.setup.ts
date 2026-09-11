import { afterAll } from 'vitest';

/**
 * Composers reach their markdown editor through a dynamic `import()` — the
 * chunk is the whole Tiptap stack, and the board's bundle must not carry it.
 * A promise is the wrong shape for a test, though: a form built in one line
 * and asserted on the next would be asserted on before its editor existed,
 * and every test that touches a composer would have to know that.
 *
 * So the suite hands the composer the REAL module, synchronously. Not a
 * stand-in: a stand-in is a second implementation to keep honest, and these
 * tests are about what a person types into the box.
 *
 * …and only where there IS a document. This file runs before EVERY test file,
 * so a STATIC import of the chunk evaluated the whole Tiptap stack 429 times
 * a run — 36.5s of CPU on the measurement that produced this change, most of
 * it for files (the MCP client, the repo scripts, core) that have no DOM and
 * could never build a composer. The environment is what says which those are:
 * `environment: 'node'` has no `document`, and a ProseMirror view cannot
 * mount there at all. Loading it behind that test costs the DOM files
 * nothing and takes the whole cost off everybody else.
 */
const hasDom = typeof document !== 'undefined';

/**
 * No test page's own origin has a server behind it, so a fetch there is
 * refused without dialling out.
 *
 * happy-dom puts every test page at `http://localhost:3000`, so a relative
 * `fetch('/workspaces/…')` from code under test — a task panel's link titles,
 * a meeting strip's poll — used to open a real socket to localhost:3000 and get
 * ECONNREFUSED. 339 of them in one run of this suite, from twelve files, each
 * printed to stderr by happy-dom. The code under test already catches them:
 * this rejects the same way (a `TypeError`, as a refused fetch does) but
 * without the connect, which on a loaded machine is not free — a lost
 * `localhost` race leaks kernel TCP blocks on the Mac this suite runs on.
 *
 * Only the page's own origin: an absolute URL to a server a test started
 * itself goes through untouched, and a test that stubs `fetch` replaces this.
 */
if (hasDom) {
  const dialOut = globalThis.fetch;
  const refuseOwnOrigin: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url, location.href).origin === location.origin) {
      return Promise.reject(new TypeError(`fetch ${url}: no server behind the test page's origin`));
    }
    return dialOut(input, init);
  };
  globalThis.fetch = refuseOwnOrigin;
  if (window !== (globalThis as unknown)) window.fetch = refuseOwnOrigin;
}

if (hasDom) {
  const composerChunk = await import('./packages/workspaces-app/src/md-composer-chunk.ts');
  const { setComposerEditorLoader } = await import('./packages/workspaces-app/src/md-composer.ts');
  setComposerEditorLoader(() => composerChunk);
}

/**
 * End every composer a file left running, before vitest takes the environment
 * away.
 *
 * A composer is a ProseMirror view, and a live view keeps a `DOMObserver` that
 * arms a 20ms flush on any mutation and cancels it on none. When that flush
 * lands after teardown it reads `document` and fails the whole run with an
 * unhandled `ReferenceError`, blamed on whichever file the worker happened to
 * be running — which is why the symptom kept naming files that mount nothing.
 * Destroying the view is what makes the pending timer harmless: `flush` returns
 * at once once `docView` is null.
 *
 * Files that own a composer should still end it themselves, per test. This is
 * the floor under the ones that don't: 441 of the 451 views the suite leaked
 * when this was written were composers, spread over thirty-odd files.
 */
afterAll(async () => {
  if (!hasDom) return;
  const { destroyLiveComposers } = await import('./packages/workspaces-app/src/md-composer.ts');
  destroyLiveComposers();
});
