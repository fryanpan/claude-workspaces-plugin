# One Access application per project

Each project's server sits behind a Cloudflare Access application of its own,
over that project's hostnames. Each application issues stamps with its own
audience, and each server admits only the audience of the application in
front of the host a request arrived on. So a stamp one project's server
received cannot be replayed to another project's server: it carries the wrong
audience there.

## Making them

`bun run cf:plan` and `bun run cf:apply` (`../cloudflare/README.md`) make
every application this file describes, with the rest of the account's
Cloudflare configuration. The config takes each project's hostnames as
written rather than deriving them. A project's own hostname is
`<project>-<first label of the one address>.<zone>`, one level under the zone
(`riverbend-workspaces.<zone>`; board router README), so that is the host to
list.

Per project, the OpenTofu config (`../cloudflare/access.tf`) makes:

1. the application `board <project>`, `self_hosted`, over the project's
   hosts, adopting the live one of that name if it exists;
2. a reusable `allow` policy `<project> people` for the emails and domains,
   and a `non_identity` policy `<project> service tokens`, each service token
   named here resolved to its id by name.

After an apply the wrapper prints each server's `CF_ACCESS_AUD` and
`CF_ACCESS_HOST_AUDS` (`hostAudiencesFor`). Before tofu runs it refuses, with
nothing changed:

- a project host equal to, or under, a hostname that an application the config
  does not own covers (a wildcard counts as its base name). Prod's sign-in
  application is never changed or shadowed;
- a service token name that matches no token, or more than one;
- an application named `board <project>` that is not `self_hosted`, or two
  of them.

Removing a project from this file removes its application at the next apply;
the plan shows it as a destroy first.

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

Tests: `packages/server/test/access-apps-plan.test.ts` (this file's
parser), `../cloudflare/tests/plan.tftest.hcl` (what a plan makes from it),
`packages/server/test/cloudflare-tf-discover.test.ts` (the refusals) and
`packages/server/test/access-per-project.test.ts` (two servers, the router, and
stamps from three applications).
