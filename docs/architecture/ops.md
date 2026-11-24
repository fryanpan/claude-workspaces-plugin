# Ops modules: supervisor, liveness, memory and deploy

The Ops box's modules: health and restart limits, liveness and the event loop, memory probes, server starts, dependency install and deploy restarts. The health check's budgets are [supervisor.md](supervisor.md).

> Moved out of [overview.md](overview.md) on 2026-11-24, when the overview was cut to a map. "The diagram" and "the picture" below mean the package diagram there.

`supervisor-health.ts` joins Ops and moves no boundary. It is the health
check `scripts/serve.ts` runs against the server it supervises — one HTTP
request to a route that already exists, a verdict, and a restart ledger that
outlives the supervisor — so the server imports only its probe-marker
constant, and only so `sentry.ts` can leave the probe out of tracing.

`supervisor-restarts.ts` joins Ops beside it and moves no boundary. It is the
half of that check which has to remember something across a process: the
three-per-hour limit, the `supervisor-restarts.json` ledger it reads, and the
first-bind grace the ledger lengthens. The split is one-way —
`supervisor-health.ts` imports it and nothing imports back — and it exists
because the two halves answer different questions: the health file reads a
socket, this one reads a file written by a supervisor that no longer exists.
`server-starts.ts` reads the same ledger, and now reads its `restarts` field
rather than a bare array.

`liveness.ts` joins Ops and moves no boundary. It is a pure description of
whether THIS process is bound and owns the machine's discovery slot, which
`GET /api/deploy` carries beside the deploy verdict. It sees no `Request` and
does no I/O: `bin.ts` constructs the one real discovery reader, on the same
seam rule as `deployer` and `secretWriter`, so no test resolves the
developer's own `~/.claude`.

`event-loop.ts` joins Ops and moves no boundary. It is an observer plus a
helper, importing nothing from the subsystems it watches: a lag monitor that
reports a turn which held the single JS thread past a threshold and names the
requests in flight at the time, and `timeSlice`, the budget a long pass uses to
hand the loop back. `server.ts` registers each request at the front door and
arms the monitor beside the other running-board timers; `doc-suggest-ops.ts` is
its first `timeSlice` caller. The reason it exists is that the 2026-09-16
outages were legible only as a 404 that took 56 seconds — the block itself was
recorded nowhere, and whether a stall was a synchronous pass or the OS
descheduling the process could not be told apart. A stall with nothing in
flight is that second thing, and the line says so.

`heap-probe.ts` joins Ops beside it and moves no boundary; only
`event-loop.ts` imports it. A block over a second also says whether a garbage
collection ran during it (a `WeakRef` sentinel re-armed every tick, because
JavaScriptCore exposes no GC timings) and, at most once a minute and only when
the last measured rate predicts under 300 ms, the heap's size, object count and
ten commonest types. It was added after eight CPU-bound 2–3 s blocks on
2026-10-31 that a 1,000-task fixture could not reproduce, so the next one has to
say for itself whether it was the collector or JavaScript.

`memory-log.ts` and `memory-footprint.ts` join Ops and move no boundary. They
write the `[doc-store] mem` line: the footprint macOS counts, read every 30
seconds through `bun:ffi`, printed on a 64 MB move or every five minutes, with
the window's requests by route family and its busiest doc-store activator.
Each line also carries the JS heap, and every ten minutes one carries the
heap's commonest object types and biggest growers, so heap growth can be told
from native growth. `doc-store.ts` owns the sampler and `server.ts` counts each request at the
front door; neither module imports a subsystem.

`server-starts.ts` joins Ops and moves no boundary. `bin.ts` records every
start of the process in `server-starts.json` beside the deploy log: once at
start, and again once serving, with the deploy it confirmed. It reads the
watchdog's restart ledger at that moment, because the ledger keeps only an
hour. `scripts/server-starts.ts` (`bun run starts:report`) reads a day of
those records back for the health check, and the planned uptime report will
use the same record to label outages as deploys.

`dependency-install.ts` joins Ops beside it and moves no boundary. It is the
`bun install --frozen-lockfile` runner, taken out of `deploy.ts` so the deploy
verb and `scripts/serve.ts` run one copy: the verb installs before the restart
it schedules, and the supervisor installs before it builds or boots, which
covers the manual pull-and-kickstart fallback the verb never sees.

`deploy-restart.ts` joins Ops beside it and moves no boundary; the `deploy*.ts`
glob draws it. It is how the deploy verb restarts the server: a graceful
shutdown that exits 75, which `scripts/serve.ts` turns into its own non-zero
exit, so launchd's KeepAlive relaunches the job. It replaced a `launchctl
kickstart -k`, after which the supervisor exited 0 and stayed down whenever
launchd did not complete the kickstart.

`supervisor-reap.ts` joins Ops beside them and moves no boundary. It is the
SIGTERM-then-SIGKILL sequence `scripts/serve.ts` runs on its children before it
exits, moved out of the script so a test can drive it, and it imports nothing
from the server.

`supervisor-stop.ts` joins Ops beside them and moves no boundary. It is the
exit code the supervisor uses on a stop signal, non-zero under launchd so the
job comes back, and it imports only a Node builtin because `scripts/serve.ts`
loads it before `bun install` runs.

`supervisor-hang-capture.ts` joins Ops beside them and moves no boundary. It is
what the supervisor records before it restarts a server that is listening and
not answering: a `sample` of the child into the data directory, the machine's
swap and memory-pressure readings, and the child's RSS and page-ins.
`supervisor-health.ts` imports its budget and runs it through an injected hook;
it imports nothing from the server.

`supervisor-boot-steps.ts` joins Ops beside them and moves no boundary. It is
the log line `scripts/serve.ts` writes before and after each step it runs
before spawning the server (install, `git describe`, port wait, both client
builds), with a still-running line every minute for the async ones. It
imports nothing from the server.
