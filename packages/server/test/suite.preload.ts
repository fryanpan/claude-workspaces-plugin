/**
 * The one preload every `bun test` run of the server suite loads, named by
 * the bunfig.toml at the repo root, in packages/server and in
 * packages/server/test.
 *
 * Bun reads the bunfig.toml in the directory it was started in and no other.
 * Before packages/server had its own, a test run from there loaded none of
 * these: its servers bound every interface, another process's 127.0.0.1
 * listener answered their connects, and the test failed on a fixture's bare
 * `not found` 404 (learnings.md, "Preloads load only from"). One file named
 * by all three bunfigs means their lists cannot drift apart.
 *
 * Ordered: the timing scale must be in the environment before any test file
 * imports the server, because the doc cadences resolve at module load.
 */
import './timing.preload.ts';
import './fd-contention.preload.ts';
import './loopback-bind.preload.ts';

/** Read by `test/preload-from-any-dir.test.ts`: set only once all three ran. */
process.env.CW_TEST_SUITE_PRELOADED = '1';
