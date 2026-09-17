# The supervisor: how prod decides its own server is dead

Prod does not run the server directly. `scripts/serve.ts` runs under launchd,
builds the client, spawns the server as a child, and then watches it. launchd
itself only watches the *process*: `KeepAlive` restarts a server that exits
and is blind to one that is still running and no longer working. This page is
about the half launchd cannot see — the health check the supervisor runs
against its own child, what it does when the answer does not come, and the two
limits that stop it doing that too often.

The mechanics live in `packages/server/src/supervisor-health.ts`, whose file
header carries the design reasoning; `scripts/serve.ts` only schedules the
ticks and names the timings. This page is the summary a reader wants when prod
has just restarted itself and they need to know whether that was the watchdog.

**The whole thing turns on one sentence: a boot in progress is not a dead
server.** Getting that wrong is what made the watchdog the outage on
16 September rather than the cure, and the worked example at the foot of this
page is that day.

## What the check asks

Every 30 seconds the supervisor opens a TCP connection to the port it asked
the child to bind, writes one HTTP request, and reads the status line back.

The probe it replaced stopped at the TCP connection and called the server
healthy on the `connect` event. That is not a reading of the server at all:
the kernel completes the handshake out of the listen backlog whether or not
the process is running JavaScript, so a server whose main thread is parked —
the 2026-09-04 reboot parked one for ~20 minutes in a synchronous open of a
cloud-synced file — passes every check while answering nobody. A status line
is different: nothing writes one until the server's own fetch handler has
returned a `Response`, which only happens when the event loop runs.

The request is `GET /api/deploy`, because it is cheap and exists wherever the
watchdog runs. `/api/metrics` was the obvious pick and the wrong one — it
walks the meetings tree on every request, which is fine once a day and not
2,880 times. The probe carries `x-cw-supervisor-probe: 1`, which only tells
`sentry.ts` to leave it out of tracing; no gate reads it.

One probe gives one of five verdicts:

| Verdict | What came back | What it means |
| --- | --- | --- |
| `answering` | a 2xx status line | the loop runs |
| `refused` | a status line, not 2xx | the loop ran to produce it — **not** a reason to restart, because the replacement would refuse the same way forever |
| `no-answer` | the connection opened, nothing HTTP came back inside 10s | the wedge this module exists to catch |
| `not-listening` | the connection never opened (refused, or no handshake inside 2s) | the alive-but-unbound case |
| `inconclusive` | this host could not give the probe a socket at all | evidence about the machine, none about the server |

`refused` and `inconclusive` are each there because of a failure that got
counted as a dead server once. `inconclusive` holds the failure count where it
is rather than resetting or incrementing it: a socket shortage says nothing
about the server, but it must not launder an unbound one either.

## The clock: first probe at 45s, first restart at 75s

Three constants in `scripts/serve.ts` set the budget, and the arithmetic is
worth writing out because the answer is not either of the three numbers:

```
GRACE_MS  = 15_000   // wait this long before arming the interval
CHECK_MS  = 30_000   // one probe per interval
MAX_FAILS = 2        // consecutive failures before a restart is asked for
```

`setInterval` fires its first callback **one interval after it is armed**, not
immediately. So the first probe lands at `GRACE_MS + CHECK_MS` = **45s**, and
the first restart at `GRACE_MS + MAX_FAILS × CHECK_MS` = **75s**.

That 75s is the budget a server actually gets, and it was being read as 45s —
by people and by agents, including in this repo's own tickets. The ledger
settles it: the two children the watchdog killed on 16 September lived 76.0s
and 75.5s. If you are reasoning about whether the watchdog had time to act,
75s is the number.

## The first bind gets 240s

`createServer` hydrates every persisted document **before** it binds its port.
So between the spawn and the first bind there is a live, healthy process with
nothing on the port, and a probe against it reads `ECONNREFUSED` —
`not-listening`, the same verdict a server that lost its port gives.

The **first** bind of a supervisor's life therefore gets
`FIRST_BIND_GRACE_MS` = **240s** before an unopened connection counts against
it. Four properties of that grace matter:

- **It applies to `not-listening` only.** `no-answer` requires a completed
  handshake, so something *is* bound and "nothing has ever bound" is false by
  construction. A server that bound and then stopped answering keeps its 75s,
  unchanged.
- **The "has anything ever bound" flag lives in memory, deliberately.** A
  restart ends the supervisor and launchd spawns a fresh one whose child is
  genuinely booting again, so the fact has to reset with it. Persisting it
  would deny the grace to precisely the boot the old code killed.
- **Every tick inside the grace logs the elapsed boot seconds.** Eight lines
  at most, bounded by the grace itself. They are what says afterwards whether
  the grace was generous or barely enough, auditable against the same
  `server-starts.json` the number came from.
- **240s is exactly eight check intervals**, so the grace expires on a tick
  boundary rather than mid-interval.

The cost in the other direction: a server that is alive, unbound, and would
have been cured by a restart now waits 240s plus two ticks — about 285s —
instead of 75s. The next section is why that trade is the right one.

## And each never-bound restart doubles it for the boot after

One grace saves one slow boot. It does not save a machine on which *no* boot
finishes, and that is the state prod was in at 23:12Z: each restart re-ran a
full hydration on an already-loaded machine, so restarting on a fixed cadence
made the thing it was waiting for less likely.

So the grace is a base, not a constant. When a supervisor arms it reads the
ledger, counts the restarts inside the limiter's hour that killed a boot which
had **never bound**, and doubles the base once per count —
240s → 480s → 960s — up to `FIRST_BIND_GRACE_MAX_MS` = **960s**. That ceiling
is 4× the base, so it saturates after two; without one, a machine that spent a
bad hour would carry an hours-long grace into the next generation and the
watchdog would stop being able to act at all. 240 + 480 + 960 = 28 minutes
across the three generations the limiter allows in its hour, so **the limiter
stays the outer bound** — which is what keeps episode one's story true.

Two things decide whether this is right, and both are about the word *unbound*:

- **Only a never-bound restart counts.** `supervisor-health.ts` classifies the
  restart it is about to ask for — `not-listening` with nothing ever bound in
  this supervisor's life — and writes only those into the ledger's `unbound`
  list. A restart of a server that bound, answered and then went silent is the
  wedge this watchdog was *built* for: it is cured by restarting, it says
  nothing about how long a boot takes, and feeding it in here would slowly
  blind the watchdog to its own purpose.
- **`unbound` is a subset of `restarts`**, in the same file, and a ledger
  written before the field existed reads as "no never-bound restarts" — the
  base grace, which is the safe direction. The loader drops any `unbound`
  entry that `restarts` does not also name, because the count only means
  something while the subset invariant holds.

The supervisor says so at arm time rather than at the restart it prevents:
one line naming how many never-bound restarts it found and how much grace
that bought. Without it the backoff is invisible in the log a person reads
after an outage — the next four minutes are silence either way.

## Where 240s comes from, and why it is not tighter

`server-starts.ts` records `startedAt` (the child's time origin) and
`servingAt` (port bound, documents hydrated) for every boot, in
`server-starts.json` beside the deploy log. That pair is exactly the window a
first-bind grace has to cover — the two client builds finish *before* the
child is spawned, so they are outside it.

Over the **171 boots that served**, out of 174 in prod's record from
2026-09-11 to 2026-09-17:

| p50 | p90 | p95 | p99 | largest |
| --- | --- | --- | --- | --- |
| 2.9s | 4.0s | 8.8s | 35.6s | **109.9s** |

**That 109.9s is right-censored, and the censoring is the argument for the
margin.** It is the largest boot that *completed*. Three more boots were
killed by this very watchdog at ~75s and never wrote a `servingAt` at all, so
how long they needed is unobserved — the distribution above 75s was truncated
by the mechanism the grace exists to change. 109.9s is therefore a **floor on
the maximum, not the maximum**, which is why the margin is 2.2× rather than
the 1.5× a reader who took 109.9s for the true maximum would think sufficient.

So: **do not tighten this constant against this table.** It would take a
record gathered while the grace was in force, where boots above 75s are
allowed to finish and say how long they took. A grace derived from the p99
would have killed the 109.9s boot, which survived only because the restart
limiter had already spent its three for that hour — the watchdog did ask, and
the minute-by-minute of that ask is in episode one below.

One more reading of the same record, and it is the strongest argument that the
grace can afford to be generous: **in 171 boots the watchdog has never been
observed to cure an alive-but-unbound server.** All three never-served entries
were killed by it at ~75s; not one was seen giving up on its own. A mechanism
with no recorded success and three recorded kills can wait five minutes.

A premise that did not survive the same measurement, recorded so it is not
re-derived: *each restart makes the next boot slower* is not in the data. The
14:41Z storm ran 54.9s → 20.7s → 109.9s, which is not monotone, and the
23:14Z storm ran killed → killed → 25.2s. What the record shows is a heavy
tail under load — a 3× jump from p99 to the largest — not a ratchet.

## The restart limit: three per rolling hour

A restart is not free. It drops every connected client, re-runs two client
builds, and re-hydrates every persisted document — and every dropped client
reconnecting at once is itself more load, which is the shape the 2026-09-04
socket shortage had. A server that is *slow* under load rather than stuck can
miss two probes in a row, and a wedge a restart cannot cure (a boot parked on
a macOS consent dialog, which only a human click ended) would otherwise become
a restart every ~75s forever.

So `WATCHDOG_RESTART_POLICY` allows **at most 3 watchdog restarts in any
rolling hour**. Past that the supervisor logs the time the next one becomes
allowed and does nothing.

The limit is kept in a **file** — `supervisor-restarts.json` in the data
directory — and the file is the whole reason the module has a ledger
abstraction at all: a restart *ends the supervisor process*, so only something
on disk can remember that it happened. It is written via rename, so a crash
mid-write leaves the old ledger rather than half a new one, and a missing or
unreadable file reads as empty: the watchdog fails **open**, because a limit
that cannot be read must not become a watchdog that can never act.

Two neighbouring mechanisms are often confused with this one and are not it:

- **A child that *dies* is not the watchdog's path at all.** `server.on('exit')`
  handles that, with its own damper: a child that dies within 30s of starting
  makes the supervisor hold 20s before exiting, so launchd's 10s
  `ThrottleInterval` does not turn a young crash into a hot loop of client
  builds and hydrations.
- **`GET /api/deploy`'s verdict is about the last deploy, not about liveness.**
  It reads `healthy` straight through an outage. Peers read it as liveness
  twice on 16 September. The probe uses that route because it is cheap to
  serve, not because its body means anything to the check.

## Worked example: 16 September 2026

Two outages the same day, about ten minutes each. They are split here by which
fault DOMINATED, not by which faults were present: the first is mostly one
request holding the event loop, the second mostly the watchdog killing boots.
Both appear in both, and the second is the one this page exists for.

### Episode one, from 14:40:52Z — a restart of a server that was alive

A `POST …/suggestions/resolve_all` on one doc ran **114,650 ms** and returned
200. It was a single synchronous turn: `resolveAllSuggestions` returned a
plain union rather than a Promise, its caller did not `await` it, and its cost
is quadratic because every resolution re-scans the whole prose fragment. The
machine was swap-thrashing, which is what made it that slow, but the shape is
the fault.

While it ran, nothing else on the single JS thread ran either. The signature
in the log is requests that compute *nothing* returning late: a `GET /events/…`
taking 56,016 ms and returning **404**; eight `GET /api/calendar/events` taking
12,973–14,427 ms and returning **403**. A 403 cannot take fourteen seconds to
compute — those requests sat in the accept queue and came out together when
the loop was handed back.

The supervisor's probe is a request like any other, so it queued too. Two
probes timed out at 10s each, and the watchdog concluded the server was dead
and restarted a server that was perfectly alive. That repeated three times,
the limiter then refused a fourth until **15:41Z**, and every board on the
machine was unreachable for seven minutes.

The 109.9s boot in the table above is from this storm: `startedAt`
14:47:27.781Z, `servingAt` 14:49:17.721Z.

**Episode one hit the unbound pattern too**, which no reconstruction of the day
noticed until the error log was read beside that record. The log carries `not
listening (ECONNREFUSED)` at 14:42:30 (1/2), and then at 14:48:14 (1/2) and
14:48:43 (2/2) — and those last two sit **inside the 109.9s boot**, between its
start and its bind. It reached 2/2 at 14:48:43, the watchdog asked for a
restart, the limiter refused because three had already been spent that hour,
and the boot bound 34 seconds later.

That is the whole argument for the grace, in one incident. The longest boot in
the entire record was condemned by the watchdog, saved by a rate limit that
exists for an unrelated reason, and was half a minute from working. It also
means the blocked loop and the killed boot are not one episode each: the
first-bind grace is a fix for both halves of the day.

### Episode two, from 23:12:50Z — the watchdog killing boots

The opening is the same defect: slow requests starved the probe (`GET
/api/deploy` itself took 12,931 ms, a thread POST 8,577 ms), two checks timed
out, and the supervisor restarted. Then it diverges.

```
23:12:50  health: :8787 not answering (connected, no reply within 10000ms) (1/2)
23:13:18  health: :8787 not answering (connected, no reply within 10000ms) (2/2)
23:13:21  server alive but not answering — restarting via launchd
23:13:26  1 child(ren) ignored SIGTERM after 5s — SIGKILL
23:15:25  health: :8787 not listening (ECONNREFUSED) (1/2)
23:15:52  server alive-but-unbound — restarting via launchd
23:17:06  health: :8787 not listening (ECONNREFUSED) (1/2)
23:17:34  server alive-but-unbound — restarting via launchd
```

After the SIGKILL the replacement process is up and hydrating documents. It
has written its discovery file. **Nothing is bound to 8787 yet.** The probe
reads `ECONNREFUSED`, the watchdog calls it alive-but-unbound, and it restarts
a boot that was going to succeed — then does it again. Correlating
`supervisor-restarts.json` against `server-starts.json` dates it exactly:

| child started | lifetime | ever served |
| --- | --- | --- |
| 23:14:36.277Z | **76.0s** | never |
| 23:16:18.566Z | **75.5s** | never |
| 23:17:43.608Z | bound in 25.2s | yes |

Both killed boots died at the 75s budget, neither ever wrote a `servingAt`,
and the survivor needed 25.2s. Each kill cost another two client builds and
another full hydration on an already-loaded machine. Prod recovered unaided —
the watchdog stopped because the third boot happened to be fast, not because
anything cured it.

Under the current grace both of those boots would have been left alone: 76.0s
and 75.5s are well inside 240s.

**The whole episode now reads as one restart rather than three**, and that is
measured rather than asserted. `supervisor-health.test.ts` replays this shape
across supervisor generations on an injected clock — one wedge (`no-answer`,
a fair restart) followed by a port held unbound — and counts restarts inside
the 253 seconds the log above covers, 23:13:21 to 23:17:34. With the grace
off, the replay produces exactly what the log shows: three restarts and then
the limiter refusing a fourth. With it on, one. The restart that remains is
23:13:21, the only one of the three that was right.

### What it looked like from outside, and what was not at fault

A peer on the same machine saw 8787 refusing connections while staging on 8788
stayed up, three `create_thread` calls failing, and a `replay.gap` across six
docs on recovery. Two peers read `GET /api/deploy`'s `healthy` as liveness and
concluded the server was fine.

The doc store's own protection worked exactly as designed throughout:
`[slow-fs] quarantined … for 60s` and `bound file is not answering; writes
parked` on files in four other repos. That mechanism is not implicated — it is
what kept the content safe.

### What each half shipped as

- **PR 1090** — the cure for the blocked loop and the instrument for the next
  one. `resolveAllSuggestions` is async and yields on a 50ms elapsed-time
  budget, so a probe queued behind it is answered while it still runs;
  `packages/server/src/event-loop.ts` adds a lag monitor that logs `[loop]
  blocked <n>ms` and names the requests in flight, because the 16 September
  blocks were legible only as a 404 that took 56 seconds.
- **PR 1092** — the first-bind grace, and the measurement it is derived from.
- **PR 1094** — this document.
- **The backoff on that grace**, plus the `liveness` field below, which is the
  answer to the reading failure in the section above it.

## The reading failure: `liveness` beside the deploy verdict

Two peers read `GET /api/deploy` as liveness, and the route did not carry it.
Its `verification` field describes the boot that followed the last
`POST /api/deploy` — it reads `healthy` for as long as nothing deploys again,
including through the seven minutes prod was unreachable.

So the GET now answers two claims, side by side:

| field | the question it answers |
| --- | --- |
| `deploy` | what the last deploy did, and whether the boot it asked for came up |
| `liveness` | is **this** process bound, right now, and does it own the machine's discovery slot |

`liveness.ok` is true only when both halves hold. It goes false for a server
that has not bound yet, and for one that is bound while **another** server
owns `~/.claude/claude-workspaces/server.json` — staging's normal state, up
and reached by no local agent. The field carries a `detail` line naming which
claim it is, because the failure it exists for was a reading failure rather
than a measurement one.

It changes nothing about the watchdog, which already knows whether the port is
bound: it is the thing probing it. The gate is unchanged too — the read stays
trusted-local, and a share visitor is refused before either field is built.
`packages/server/src/liveness.ts` is the pure description; `bin.ts`
constructs the one real discovery reader, cached so the route the supervisor
probes every 30s performs a bounded number of synchronous opens.

## One phrase the log must keep

Both unbound restart lines lead with `[supervisor] server alive-but-unbound`,
and the rest of each line says which of the two faults it was: a server that
was listening earlier and is not now (the reload wedge), or a first bind that
never arrived inside the whole grace. They share that stem because
`alive-but-unbound` is what the 24-hour restart criterion greps for. Splitting
the message into two strings without a shared stem would have made the more
serious of the two faults the invisible one.

## Where things live

| What | Where |
| --- | --- |
| Probe, verdicts, fail-counting, watchdog | `packages/server/src/supervisor-health.ts` |
| Restart limit, ledger, first-bind grace and its backoff | `packages/server/src/supervisor-restarts.ts` |
| The `liveness` field on `GET /api/deploy` | `packages/server/src/liveness.ts` |
| `GRACE_MS` / `CHECK_MS` / `MAX_FAILS`, and arming the ticks | `scripts/serve.ts` |
| Fast-crash damper for a child that dies young | `scripts/serve.ts` |
| Per-boot `startedAt` → `servingAt` record | `packages/server/src/server-starts.ts` → `server-starts.json` |
| A day of those records, read back | `bun run starts:report` |
| Restart ledger on disk | `supervisor-restarts.json` in the data directory |
| Event-loop lag monitor and `timeSlice` | `packages/server/src/event-loop.ts` |
| Cases | `packages/server/test/supervisor-*.test.ts` |

Where prod's data directory, checkout and launchd job live is in
[CLAUDE.md](../../CLAUDE.md) under "Where prod lives"; the deploy verb that
schedules a restart is in
[docs/process/delivery.md](../process/delivery.md).
