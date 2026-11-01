# Board router Worker

Each project's boards answer on a hostname of their own, wherever that
project's server runs: `<project>-<first label of the one address>.<zone>`.
With the one address `workspaces.<zone>`, Riverbend's boards are at
`riverbend-workspaces.<zone>`. This Worker reads the hostname, sends the
request down that project's tunnel and no other, and cuts the request's
cookies down to the ones a project server set for its own host. A project
the table does not list gets a 404 from the Worker, and there is no default
server.

The name is one level under the zone, beside the one address rather than
under it, so the zone's free Universal SSL certificate covers it
("Certificate"). It cannot collide with an origin hostname
(`<project>-origin.<zone>`): the deploy refuses a one address whose first
label is `origin`, and any origin shaped like a project hostname. Nor with
the frame domain's names, which carry no `-<first label>` suffix.

The one address itself keeps working as it does today: there the board id in
the path (`/workspaces/<id>/…`) picks the server. Boards stay on those paths
until they move.

The Worker routes; it does not authorize. It forwards the
`Cf-Access-Jwt-Assertion` header as it arrived, and each server verifies that
stamp against Cloudflare's public keys itself
(`packages/server/src/middleware/cf-access.ts`). A request reaching a server
with no stamp, or a forged one, is refused there.

## How a request travels

1. The browser asks `https://<project>-<first label>.<zone>/…`.
2. Access checks the sign-in and stamps the request (once that project has an
   Access application; until then the server refuses it for want of a stamp).
3. The Worker looks `<project>` up in `PROJECT_ORIGINS` and calls `fetch` with
   `cf.resolveOverride` set to that project's origin hostname. The Host header
   stays `<project>-<first label>.<zone>`, so pages stay same-origin.
4. The origin hostname's DNS record points at the project's tunnel, which
   delivers the request to the server on loopback.

On the one address, step 3 reads the board id from the path instead, from
`BOARD_ORIGINS`. A path that names no board, such as the app's scripts, takes
the board of a `Referer` on the same host. A Referer from any other host names
nothing.

## The tables

`PROJECT_ORIGINS` maps each project's label to its origin:

```json
{"riverbend": "<riverbend-origin-hostname>", "harborlight": "<mac-origin-hostname>"}
```

`BOARD_ORIGINS` is grouped by machine, for the one address:

```json
{"<mac-origin-hostname>": ["<board-id>", "<board-id>"],
 "<project-origin-hostname>": ["<board-id>"]}
```

`ONE_ADDRESS` names the one address, and the project hostnames follow from
it: the Worker strips `-<first label>.<rest>` from the hostname and looks up
what is left. A host that is neither the one address nor `<label>-<first
label>.<rest>` gets a 404, and so does a deeper name such as
`a.riverbend-workspaces.<zone>`. With `ONE_ADDRESS` unset there are no project
hostnames, and every request is routed by board, as before they existed.

`ONE_ADDRESS_ORIGIN` names the origin that owns the one address's Access
application (`oneAddressOrigin` in `router.local.json`). Set, the one address
forwards a board only to that origin, and answers a board any other origin
holds with a 308 to `<its project>-<first label>.<zone>`, path and query kept. A
board on an origin with no project label, or with two, gets a 404. So Bryan's
stamp for the one address never reaches another machine, which could replay
it to the Mac. Unset, every board is forwarded, as before each project had an
application of its own; malformed, the one address routes nothing.

`FRAME_DOMAIN` names the frame domain, a domain that is not the one
address's, where each project's mocks and app doors run on
`<project>.<frame domain>` (`packages/server/src/frame-host.ts`). The Worker
sends that hostname to the project's origin from `PROJECT_ORIGINS`, exactly as
it sends the project's own hostname. A frame domain that is the one address, sits
under it, or holds it routes no frame, because the frames would be back on the
board's site. Unset, no frame hostname is routed.

A missing or malformed table routes nothing. Malformed means any of: not a JSON
object, an origin that is not a bare lower-case hostname, a label that is not
one lower-case DNS label, a board id outside `[A-Za-z0-9_-]`, or one board
listed under two origins.

## Cookies

A browser sends `name=value` and nothing else, so the Worker cannot see which
domain a cookie was set for. It keeps cookies by name and drops every other
one before the request leaves:

| Kept | Set by | Why it survives |
| --- | --- | --- |
| any `__Host-…` name | the server | A browser accepts a `__Host-` cookie only with no Domain, so it was set by this exact host. The session is `__Host-cw_session` (PR 1353). |
| `cw_session` | the server | The session's name over http, and over https until 4 November 2026 (`PLAIN_SESSION_OVER_HTTPS_UNTIL`, `auth/session.ts`). |
| `lf_share` | the server | A redeemed share link. Signed with the server's own key. |
| `cw_geo`, `cw_touch` | the app's own page script | Where an event came from (`device-context.ts`). They label events and grant nothing. |

Everything else is dropped. That includes `CF_Authorization`: Access sends
the same token as the `Cf-Access-Jwt-Assertion` header, which the server
reads first, so a project server never receives the parent domain's Access
cookie.

A cookie set on a parent domain under one of the four unprefixed names still
gets through, because nothing in the request tells it apart. Each is signed
or labels an event only, so a planted one can sign a reader out but reads
nothing. That is the accepted risk in the design (decision 16). Renaming
`lf_share` to `__Host-lf_share` would close it for share links.

On a frame hostname only `cw_frame` is kept: the board's frame ticket, the one
cookie a project server reads there. The board's session and share cookies
never travel to a frame hostname, and nor does anything a frame's page set.

On the way back, a `Set-Cookie` that names a Domain is removed from the
server's response, so one project's server cannot set a cookie that every
other project's hostname would receive. No server sets one today.

The project hostnames and the one address are siblings under the zone. A
cookie set for the zone (`Domain=<zone>`) is sent to all of them, which is
why the filter above runs on every request; a cookie set for the one address
reaches none of the projects. `board-router-subdomains.test.ts` ("a cookie not
set by a project server for its own host is stripped") sends zone cookies to
`riverbend-workspaces.<zone>` and checks only the kept names arrive.

## Deploying

```bash
bun run cf:plan    # reads Cloudflare, shows what would change
bun run cf:apply   # shows the plan again and asks before changing anything
```

The Worker, its routes and its records are part of the one OpenTofu config
in `../cloudflare/` (its README). It reads `router.local.json` beside this
file (gitignored; the real hostnames stay out of the public repo):

```json
{
  "zone": "<zone-name>",
  "oneAddress": "<one-address>",
  "projects": {"<label>": "<origin-hostname>"},
  "boards": {},
  "bindBoardPaths": false,
  "oneAddressOrigin": "<the Mac's origin hostname>"
}
```

`oneAddress` must be one level under `zone`, so the project hostnames are
too. From it the config makes the Worker `board-router` from `worker.js`
with the tables as plain-text vars, a proxied record for each project
hostname (AAAA `100::`, the placeholder for a name only a Worker answers; one
per project, because a DNS wildcard covers whole labels only), and a route
for each. A project added to `projects` adds a record and a route at the next
apply; one removed is removed.

Before tofu runs, the wrapper stops, changing nothing, when an origin of the
Mac's has no proxied record, when no certificate covers a project hostname,
or when a route the config names is bound to another Worker.

**Certificate.** Universal SSL covers the zone and `*.<zone>`, one level
under it, at no cost. Every project hostname is one level under the zone, so
Universal SSL covers it and no certificate needs buying. The deploy still
reads the zone's certificate packs and refuses a hostname none covers, which
catches Universal SSL switched off. The earlier scheme,
`<project>.<one-address>`, was two levels down and needed an advanced
certificate, which is why it was replaced.

**What it binds.** One route per project, `<project>-<first label>.<zone>/*`,
so the one address keeps reaching the Mac's tunnel exactly as today and no
other name in the zone reaches the Worker. A pattern like
`*-workspaces.<zone>/*` would save the per-project routes, but a route's
wildcard also matches dots, so it would take `a.b-workspaces.<zone>` as well;
listing each project keeps what the Worker answers equal to the table.
`bindBoardPaths: true` adds `<one-address>/workspaces/*`, which sends board
paths through the Worker too. Set it only once `boards` lists every board the
one address serves: a board missing from the table would get a 404.
`workers_dev` is off, so the Worker has no address outside these routes.

## Each project's side

`bun run cf:apply` makes the first two for a Fly project machine, whose
origin is `<project>-origin.<zone>` (docs/process/project-machine.md, "The
tunnel").

- **An origin hostname per machine.** A proxied DNS record pointing at the
  machine's tunnel, with no Access application on it. A visitor who types it
  directly is refused by the server, because the hostname is on none of its
  lists.
- **The tunnel's ingress names the project hostname.** cloudflared matches
  the Host header, which is `<project>-<first label>.<zone>`, so the tunnel
  needs an ingress rule for that name to the local server.
- **The server trusts the project hostname.** `CW_PROXIED_TRUSTED_HOSTS`
  lists `<project>-<first label>.<zone>` (and the one address, while boards
  are still reached there), with `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` and sharing
  configured, as on the Mac today.
- **An Access application on the project hostname.** One per project, from
  `infra/access-apps/access.local.json`, made by `bun run cf:apply`. The server admits only that
  application's audience on that hostname (`CF_ACCESS_AUD`, or the host's
  entry in `CF_ACCESS_HOST_AUDS` on a server that also answers the one
  address). Until it exists, a request to the hostname carries no stamp and
  the server refuses it, so an empty or early `projects` table exposes
  nothing.

## Not covered yet

- The frame domain is routed but not deployed. `cf:apply` binds only
  the project hostnames and the board paths; the frame domain is its own zone, which needs buying,
  a proxied wildcard record, a certificate for `*.<frame domain>` and a
  route for `*.<frame domain>/*`. Each project's tunnel needs an ingress rule
  for `<project>.<frame domain>`, and its server `CW_FRAME_ORIGIN` set to
  that origin. An Access application on the frame domain must let requests
  through to the server's frame ticket check, or Safari cannot load the frame.

- `resolveOverride` and the tunnel's Host-based ingress are documented
  Cloudflare behaviour that this repo's tests stand in for, not run.
  `packages/server/test/board-router-two-servers.test.ts` drives the handler
  against two real servers through a loopback stand-in for the tunnel.
- Home across servers reads `BOARD_ORIGINS` too: the Mac reads the same JSON
  (`CW_HOME_REMOTES_FILE`, `packages/server/src/home-remotes.ts`) and pulls
  each remote board's feed at `/workspaces/<board>/home-feed`, at the
  project's own address when the file's `addresses` names one and through
  the one address otherwise. With `ONE_ADDRESS_ORIGIN` set, only the first
  works.

Tests: `packages/server/test/board-router-subdomains.test.ts` (project
hostnames, cookies, today's board paths, `ONE_ADDRESS_ORIGIN`),
`board-router-frames.test.ts` (the frame domain),
`access-per-project.test.ts` (three Access applications over two servers), `board-router-worker.test.ts` (board routing),
`board-router-two-servers.test.ts` (two real servers),
`board-router-config.test.ts` (`router.local.json`) and
`../cloudflare/tests/plan.tftest.hcl` (what is deployed from it).
