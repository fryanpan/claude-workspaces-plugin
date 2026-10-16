# Board router Worker

One address serves every board, wherever its server runs. Cloudflare Access
signs the visitor in at that address; this Worker reads the board id from the
path (`/workspaces/<id>/…`) and sends the request down the tunnel of the
machine that holds the board. A board the routing table does not list gets a
404 from the Worker, and there is no default server.

The Worker routes; it does not authorize. It forwards the request as it
arrived, with the `Cf-Access-Jwt-Assertion` header and the `CF_Authorization`
cookie intact, and each board server verifies that stamp against Cloudflare's
public keys itself (`packages/server/src/middleware/cf-access.ts`). A request
reaching a server through its tunnel with no stamp, or a forged one, is
refused there.

## How a request travels

1. The browser asks `https://<one-address>/workspaces/<id>/…`.
2. Access checks the sign-in and stamps the request.
3. The Worker looks `<id>` up in `BOARD_ORIGINS` and calls `fetch` with
   `cf.resolveOverride` set to that machine's origin hostname. The Host header
   stays the one address, so every server is configured with the same
   hostname the Mac uses today (`CW_PROXIED_TRUSTED_HOSTS`) and the browser's
   pages stay same-origin.
4. The origin hostname's DNS record points at that machine's tunnel, which
   delivers the request to the board server on loopback.

A path that names no board, such as the app's scripts, takes the board of a
`Referer` on the same host. A Referer from any other host names nothing.

## The routing table

`BOARD_ORIGINS` is JSON, grouped by machine:

```json
{"<mac-origin-hostname>": ["<board-id>", "<board-id>"],
 "<project-origin-hostname>": ["<board-id>"]}
```

A missing or malformed table routes nothing. Malformed means any of: not a JSON
object, an origin that is not a bare lower-case hostname, a board id outside
`[A-Za-z0-9_-]`, or one board listed under two origins.

## Deploying: manual steps for Bryan

Agents never write to Cloudflare. In order:

1. **One origin hostname per machine.** In the zone, add a proxied DNS record
   for each machine (the Mac and each project machine) pointing at that
   machine's tunnel. Do NOT put an Access application on these hostnames: the
   Worker's request carries the one address's stamp, not theirs. A visitor who
   types an origin hostname directly is refused by the server, because that
   hostname is on none of its lists.
2. **Each tunnel's ingress names the one address.** cloudflared matches on
   the Host header, which stays the one address, so every machine's tunnel
   config needs an ingress rule for `<one-address>` to its local server.
3. **Each server verifies the stamp.** On every board server set
   `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` (the one address's Access
   application), `CW_PROXIED_TRUSTED_HOSTS=<one-address>` and
   `CW_PROXIED_TRUSTED_EMAILS` (the owner's email), with sharing configured. These are the
   Mac's settings today.
4. **Deploy the Worker.** Copy `wrangler.toml` to `wrangler.local.toml`
   (gitignored), fill in the one address, the zone and the table, then
   `npx wrangler deploy -c wrangler.local.toml`. The route binds only
   `/workspaces/*`, so Home, sign-in and the app's static files keep reaching
   the Mac's tunnel as today.
5. **Check before adding a second machine.** With only the Mac in the table,
   open a board at the one address and confirm it loads, comments post and the
   live socket connects. Then add a project machine's boards.

## Not covered yet

- Paths that name no board and carry no same-host Referer get a 404 from this
  Worker. With the route bound to `/workspaces/*` none of them reach it; they
  go to the Mac. Home across servers rides this table: the Mac reads the same
  JSON (`CW_HOME_REMOTES_FILE`, `packages/server/src/home-remotes.ts`) and
  pulls each remote board's feed at `/workspaces/<board>/home-feed`, which
  this Worker routes like any other board path.
- `resolveOverride` and the tunnel's Host-based ingress are documented
  Cloudflare behaviour that this repo's tests stand in for, not run.
  `packages/server/test/board-router-two-servers.test.ts` drives the handler
  against two real servers through a loopback stand-in for the tunnel.

Tests: `packages/server/test/board-router-worker.test.ts` (routing) and
`packages/server/test/board-router-two-servers.test.ts` (two servers).
