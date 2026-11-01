# Cloudflare, as one OpenTofu config

Every Cloudflare resource this repo configures is declared here, so a change
is one reviewed plan and one apply instead of a script per surface.

```bash
bun run cf:plan    # reads the account, prints what would change, changes nothing
bun run cf:apply   # prints the plan again and asks "yes" before changing anything
```

## What it owns

| Resource | From | File |
| --- | --- | --- |
| Access application `board <project>`, one per project | `infra/access-apps/access.local.json` | `access.tf` |
| Access policies `<project> people` (allow) and `<project> service tokens` (non_identity) | the same | `access.tf` |
| Worker `board-router`, its vars, no workers.dev address | `infra/board-router-worker/router.local.json`, `worker.js` | `board-router.tf` |
| A route per project hostname, plus `<one address>/workspaces/*` when `bindBoardPaths` | `router.local.json` | `board-router.tf` |
| Proxied AAAA `100::` per project hostname | `router.local.json` | `board-router.tf` |
| Worker `share-link-gate` and its `/share/*` routes, no workers.dev address | `infra/share-link-worker/wrangler.local.toml` | `share-link.tf` |
| Tunnel `cw-<project>`, its ingress, and the proxied CNAME `<project>-origin.<zone>` | each project in `router.local.json` whose origin is `<project>-origin.<zone>` | `tunnels.tf` |

The zone's and account's ids, each service token's id, and the id of each live
resource to adopt are read from the account before every plan
(`discover.ts`); none is committed.

## What stays outside, and why

- **Share applications.** The server makes one per share when a person shares
  a board, and deletes it when the share ends (`packages/server/src/share/cf-api.ts`).
  That is a runtime reaction to a person's action, not configuration, and the
  OpenTofu config neither knows nor touches those applications.
- **The keeper's Cloudflare token.** `keeper-setup` still mints it through the
  API after the person confirms. In OpenTofu its value would sit in the state
  file, which this user and every agent can read; the keeper exists so that
  no such file holds it.
- **The share-link Worker's `SHARE_LINK_KEY`.** Set once with `wrangler secret
  put` (`../share-link-worker/README.md`); `keep_bindings` keeps it across an
  apply, so the key never enters the state.
- **A tunnel's token.** `machine:deploy` reads it from Cloudflare when it sets
  the machine's `CLOUDFLARE_TUNNEL_TOKEN`, so it never enters the state.
- **`machine:deploy`'s Access reads** (`infra/project-machine/settings.ts`):
  it reads an application's audience to set a server's environment and
  changes nothing.

## How a run goes

`run.ts` does, in order:

1. Assemble the variables from the local configs (`vars.ts`).
2. Read the token from the Keychain entry `cloudflare-api-token`, the same
   reader the deploy scripts use (`mac-ops.ts`, `security`, base64-decoded).
3. Read the account (`discover.ts`), and stop before tofu runs on anything
   that a plan would repoint or shadow: a project host under an Access
   application the config does not own (prod's sign-in application), an
   Access application over a tunnel's origin, a tunnel origin's record that
   points anywhere but its own tunnel, a route another Worker holds, a
   service token name that matches no token, two resources where the config
   names one, an origin of the Mac's with no proxied record, a project
   hostname no certificate covers.
4. Write the variables to `state/run.tfvars.json`.
5. `tofu init`, then `tofu plan`, or `tofu apply`.
6. After an apply, print each project's `CF_ACCESS_AUD` and
   `CF_ACCESS_HOST_AUDS`.

The token reaches tofu as `CLOUDFLARE_API_TOKEN` in its environment and
nowhere else: never an argument, a variable or a file, so it is never in the
state. The provider does not go through the keeper, because it cannot send
the keeper's request header.

**Adopting what exists.** `imports.tf` imports each live resource
`discover.ts` found by the name this config gives it, so the first apply
updates it in place rather than making a second one. An import of a resource
already in state does nothing. Read the first plan closely: an adopted
resource shows every field the config sets differently, and the
share-link Worker loses its workers.dev address.

**Removing.** An entry removed from a local config is destroyed at the next
apply. The plan lists it as a destroy first.

## State

Local only, at `state/terraform.tfstate`, gitignored. tofu runs under umask
077 and the wrapper sets every file in `state/` to 600 and the directory to
700 after each run (`tofu.ts`). The state and the tfvars hold hostnames, ids
and the Access email lists, and no credential. There is no remote backend:
the state is on this Mac only, so `cf:apply` runs from here.

## The token's permissions

On the account: Access: Apps and Policies Edit, Access: Service Tokens Read,
Cloudflare Tunnel Edit, Workers Scripts Edit. On the zone: Zone Read, DNS
Edit, SSL and Certificates Read, Workers Routes Edit.

## Tests

`bun run check:cloudflare-tf`, a member of `bun run verify` and of CI's
`gates` job: `tofu fmt -check`, `tofu validate`, and `tests/plan.tftest.hcl`,
which plans a fixture config against a mock provider (no token, no network
call beyond the provider download). `packages/server/test/cloudflare-tf-discover.test.ts`
runs the adoption and the refusals against a fake account, and
`cloudflare-tf-wrapper.test.ts` the variable assembly, where the token goes,
and the state's file modes. What only the real account can show: the import
id formats (read from the provider's own documentation strings; OpenTofu's
mock provider cannot run an import) and the first plan's diff.
