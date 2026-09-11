/**
 * Loaded by every `bun test` run (bunfig.toml [test].preload): every server a
 * test builds with `createServer` binds 127.0.0.1 rather than the wildcard,
 * and so does every child process a test spawns, which inherits the variable.
 *
 * The suite connects by IP literal, never `localhost` (the `localhostConnects`
 * check in `scripts/test-audit.ts` says why). An IPv4 connect is answered by
 * the MOST SPECIFIC listener on its port, and on macOS a `127.0.0.1:P` bind
 * is allowed while a wildcard already holds P (Bun sets SO_REUSEADDR), in
 * either order. So a wildcard test server can have its connects answered by
 * somebody else's loopback listener: a parallel chunk's stub, headless
 * Chrome's debugging port, another worktree's suite. That happened twice in
 * two `bun run test:server` runs once the connects went IPv4-only — a recall
 * test got 403 `unknown_host` and a 500 from servers it never built. While the
 * suite said `localhost`, Bun's `::1` attempt usually won and reached the
 * wildcard's IPv6 side, which is what had hidden it.
 *
 * A server bound to 127.0.0.1 itself cannot be shadowed that way, and two
 * such binds cannot share a port. A test that needs a port to be BUSY for
 * `createServer` has to hold it on 127.0.0.1 too — a wildcard squatter no
 * longer collides (see `effort-rescore-boot.test.ts`).
 */
if (!process.env.CW_TEST_BIND_HOST) process.env.CW_TEST_BIND_HOST = '127.0.0.1';
