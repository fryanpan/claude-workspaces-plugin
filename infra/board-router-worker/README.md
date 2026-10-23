# Board router Worker

Each project's boards answer on their own subdomain of the one address,
`<project>.<one-address>`, wherever that project's server runs. This Worker
reads the subdomain, sends the request down that project's tunnel and no
other, and cuts the request's cookies down to the ones a project server set
for its own host. A subdomain the table does not list gets a 404 from the
Worker, and there is no default server.

The one address itself keeps working as it does today: there the board id in
the path (`/workspaces/<id>/…`) picks the server. Boards stay on those paths
until they move.

The Worker routes; it does not authorize. It forwards the
`Cf-Access-Jwt-Assertion` header as it arrived, and each server verifies that
stamp against Cloudflare's public keys itself
(`packages/server/src/middleware/cf-access.ts`). A request reaching a server
with no stamp, or a forged one, is refused there.

## How a request travels

1. The browser asks `https://<project>.<one-address>/…`.
2. Access checks the sign-in and stamps the request (once that project has an
   Access application; until then the server refuses it for want of a stamp).
3. The Worker looks `<project>` up in `PROJECT_ORIGINS` and calls `fetch` with
   `cf.resolveOverride` set to that project's origin hostname. The Host header
   stays `<project>.<one-address>`, so pages stay same-origin.
4. The origin hostname's DNS record points at the project's tunnel, which
   delivers the request to the server on loopback.

On the one address, step 3 reads the board id from the path instead, from
`BOARD_ORIGINS`. A path that names no board, such as the app's scripts, takes
the board of a `Referer` on the same host. A Referer from any other host names
nothing.

## The tables

`PROJECT_ORIGINS` maps each project's subdomain label to its origin:

```json
{"riverbend": "<riverbend-origin-hostname>", "harborlight": "<mac-origin-hostname>"}
```

`BOARD_ORIGINS` is grouped by machine, for the one address:

```json
{"<mac-origin-hostname>": ["<board-id>", "<board-id>"],
 "<project-origin-hostname>": ["<board-id>"]}
```

`ONE_ADDRESS` names the one address. A host that is neither it nor one label
in front of it gets a 404. With `ONE_ADDRESS` unset there are no subdomains,
and every request is routed by board, as before subdomains existed.

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

On the way back, a `Set-Cookie` that names a Domain is removed from the
server's response, so one project's server cannot set a cookie that every
other project's subdomain would receive. No server sets one today.

## Deploying

```bash
bun run router:deploy --dry-run   # reads Cloudflare, changes nothing
bun run router:deploy
```

It reads `router.local.json` beside this file (gitignored; the real hostnames
stay out of the public repo):

```json
{
  "zone": "<zone-name>",
  "oneAddress": "<one-address>",
  "projects": {"<label>": "<origin-hostname>"},
  "boards": {},
  "bindBoardPaths": false
}
```

Then it finds the zone, checks what the Worker needs, creates the proxied
wildcard record `*.<one-address>` (AAAA `100::`, the placeholder for a name
only a Worker answers) when there is none, and runs `wrangler deploy`. It
prints the version it deployed. A second run changes only the Worker's code
and tables.

It stops, changing nothing, when an origin hostname has no proxied record,
when `*.<one-address>` exists unproxied, or when no certificate covers
`*.<one-address>`.

**The token.** It reads the `cloudflare-api-token` Keychain entry into its own
environment and wrangler's, never an argument or a file. The token needs Zone
Read, DNS Edit, SSL and Certificates Read, Workers Routes Edit on the zone,
and Workers Scripts Edit on the account.

**Certificate.** Universal SSL covers the zone and one level under it. The
one address is a name under the zone (the deploy refuses the apex, whose
`*.<zone>/*` route would take every other name in the zone), so
`<project>.<one-address>` is two levels down and needs an advanced
certificate for `*.<one-address>` (Advanced Certificate Manager). That is a
purchase, so it is Bryan's call; the deploy refuses until one exists.

**What it binds.** Only `*.<one-address>/*`, so the one address keeps reaching
the Mac's tunnel exactly as today. `bindBoardPaths: true` adds
`<one-address>/workspaces/*`, which sends board paths through the Worker too.
Set it only once `boards` lists every board the one address serves: a board
missing from the table would get a 404. `workers_dev` is off, so the Worker
has no address outside these routes.

## Each project's side

- **An origin hostname per machine.** A proxied DNS record pointing at the
  machine's tunnel, with no Access application on it. A visitor who types it
  directly is refused by the server, because the hostname is on none of its
  lists.
- **The tunnel's ingress names the subdomain.** cloudflared matches the Host
  header, which is `<project>.<one-address>`, so the tunnel needs an ingress
  rule for that name to the local server.
- **The server trusts the subdomain.** `CW_PROXIED_TRUSTED_HOSTS` lists
  `<project>.<one-address>` (and the one address, while boards are still
  reached there), with `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` and sharing
  configured, as on the Mac today.
- **An Access application on the subdomain.** Step 3 of the plan. Until it
  exists, a request to the subdomain carries no stamp and the server refuses
  it, so an empty or early `projects` table exposes nothing.

## Not covered yet

- `resolveOverride` and the tunnel's Host-based ingress are documented
  Cloudflare behaviour that this repo's tests stand in for, not run.
  `packages/server/test/board-router-two-servers.test.ts` drives the handler
  against two real servers through a loopback stand-in for the tunnel.
- Home across servers still rides `BOARD_ORIGINS` through the one address:
  the Mac reads the same JSON (`CW_HOME_REMOTES_FILE`,
  `packages/server/src/home-remotes.ts`) and pulls each remote board's feed at
  `/workspaces/<board>/home-feed`.

Tests: `packages/server/test/board-router-subdomains.test.ts` (subdomains,
cookies, today's board paths), `board-router-worker.test.ts` (board routing),
`board-router-two-servers.test.ts` (two real servers) and
`board-router-deploy.test.ts` (the deploy's decisions).
