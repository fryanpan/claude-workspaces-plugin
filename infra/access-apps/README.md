# One Access application per project

Each project's server sits behind a Cloudflare Access application of its own,
over that project's hostnames. Each application issues stamps with its own
audience, and each server admits only the audience of the application in
front of the host a request arrived on. So a stamp one project's server
received cannot be replayed to another project's server: it carries the wrong
audience there.

## Not deployed

Nothing here has been sent to Cloudflare. `access-plan.ts` builds the request
bodies; no script in the repo sends them. The config takes each project's
hostnames as written rather than deriving them. A project's own hostname is
`<project>-<first label of the one address>.<zone>`, one level under the zone
(`riverbend-workspaces.<zone>`; board router README), so that is the host to
list.

```bash
bun run access:plan            # reads access.local.json beside this file (gitignored)
bun run access:plan <path>     # or any other file
```

It prints one `POST /accounts/<account>/access/apps` body per project. A deploy
would then, per project:

1. look up each named service token's id and replace every
   `{"service_token_name": …}` with `{"service_token": {"token_id": …}}`;
2. create the application, or update the one with the same `name`;
3. read back its `aud` and write that server's `CF_ACCESS_HOST_AUDS`
   (`hostAudiencesFor`) and `CF_ACCESS_AUD`.

## The config

```json
{
  "sessionDuration": "24h",
  "projects": {
    "riverbend": {
      "hosts": ["riverbend-workspaces.<zone>"],
      "emails": ["<a person's address>"],
      "emailDomains": ["<a team's domain>"],
      "serviceTokens": ["home feed riverbend", "relay riverbend"]
    }
  }
}
```

- `hosts`: every name the project's server answers on. One host under two
  projects is refused.
- `emails` and `emailDomains`: one `allow` policy. `email_domain` admits anyone
  whose sign-in proves an address on that domain, which is how a team's Google
  Workspace domain is admitted. A project with neither admits no person.
- `serviceTokens`: a separate `non_identity` policy. Home's feed token and the
  relay's token for that server go here, one pair per server, so each is
  stamped with that project's audience.

The plan doc says the board's share list is the source of truth for who is
admitted. Generating `emails` from it is not built: the list above is written
by hand.

## The server side

- `CF_ACCESS_HOST_AUDS='{"<host>": "<aud>", …}'`: a host named here is checked
  against that audience only. A host not named falls back to `CF_ACCESS_AUD`.
  A malformed value stops the server at boot, and so does an entry equal to
  `CF_ACCESS_SHARE_AUD`.
- Home pulls each remote board's feed at the project's own address
  (`addresses` in `CW_HOME_REMOTES_FILE`, `packages/server/src/home-remotes.ts`).
- The relay's `baseUrl` for each server is that project's own address
  (`packages/server/src/org-relay/relay-config.ts`).
- The router Worker's `ONE_ADDRESS_ORIGIN` (`../board-router-worker/README.md`)
  keeps the one address's stamp on the machine that owns it, and redirects
  every other board to its project's host.

## What only the real account can show

- One sign-in reaching every project: Access's team session should issue each
  application's stamp without asking again. This is untested.
- A domain policy admitting a member of the domain and refusing an outsider.
- The service tokens working per application.

Tests: `packages/server/test/access-apps-plan.test.ts` (this plan) and
`packages/server/test/access-per-project.test.ts` (two servers, the router, and
stamps from three applications).
