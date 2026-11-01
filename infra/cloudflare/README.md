# Cloudflare, in Terraform

Every Cloudflare resource this repo configures is declared here, so a change
is one reviewed plan and one apply instead of a script per surface. CI is the main path: it plans every pull request and applies on main
(`.github/workflows/cloudflare.yml`), and the Cloudflare token it uses is a
GitHub secret. Running it from the Mac is optional.

```bash
bun run cf:plan            # prod: reads the account, prints what would change, changes nothing
bun run cf:plan staging    # the same for staging
bun run cf:apply           # prints the plan again and asks "yes" before changing anything
```

## Layout

| Path | What it is |
| --- | --- |
| `modules/access` | One Access application per project, its people policy and its service-token policy |
| `modules/router-worker` | The board router Worker, a route and a proxied AAAA `100::` per project hostname |
| `modules/share-link` | The share-link Worker and its `/share/*` routes |
| `modules/tunnel` | Each project machine's tunnel, its ingress, its origin CNAME, and its token (read back) |
| `modules/stack` | The four wired together, plus the Access team domain (read back) |
| `deploys/prod` | Prod's root, and `imports.tf`, which adopts what already exists |
| `deploys/staging` | Staging's root: the same modules, no imports. Validated on every run, never applied yet |

The layout is HashiCorp's standard module structure. Each module has
`main.tf`, `variables.tf`, `outputs.tf`, `versions.tf` and a `README.md`. Each
root has `main.tf` (the provider and the `stack` call), `variables.tf`,
`outputs.tf`, `versions.tf` (Terraform `~> 1.10`, provider `~> 5.28`),
`backend.tf` and a committed `.terraform.lock.hcl`. Providers are configured
only in the roots.

No module names a real account, zone, host, person or resource. Each root's
committed `terraform.tfvars` names its Workers and the prefix on its Access
names (`staging board <project>`), so two deployments can share an account
without colliding. Everything else is a variable the wrapper
assembles:

| Variable | From |
| --- | --- |
| zone, one address, project origins and hostnames, board origins, tunnels | the board router's `router.local.json` |
| Access projects, their emails, domains and service tokens, session length | `infra/access-apps/access.local.json` |
| share-link routes | `infra/share-link-worker/wrangler.local.toml` |
| account and zone ids, service token ids, ids to adopt (prod only) | read from the account before every plan (`discover.ts`) |

Staging reads the same three configs from `deploys/staging/*.local.*`
(gitignored). In CI each config is a secret, handed in as `CF_ROUTER_CONFIG`,
`CF_ACCESS_CONFIG` and `CF_SHARE_LINK_CONFIG`.

## What stays outside, and why

- **Share applications.** The server makes one per share when a person shares
  a board, and deletes it when the share ends (`packages/server/src/share/cf-api.ts`).
  That is a runtime reaction to a person's action, not configuration.
- **The keeper's Cloudflare token.** `keeper-setup` still mints it through the
  API after the person confirms. In Terraform its value would sit in the
  state; the keeper exists so that no such file holds it.
- **The share-link Worker's `SHARE_LINK_KEY`.** Set once with `wrangler secret
  put` (`../share-link-worker/README.md`); `keep_bindings` keeps it across an
  apply, so the key never enters the state.
- **Fly.** The Fly Terraform provider is archived, and a `local-exec` keeps no
  state, so Fly stays on `machine:deploy`. CI runs it after each apply on main
  (below).

## How a run goes

`run.ts` does, in order:

1. Assemble the variables from the environment's configs (`vars.ts`).
2. Take the credentials (`credentials.ts`): `CLOUDFLARE_API_TOKEN`, and the
   state bucket's `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Each comes
   from the environment when set (CI), else from the Keychain entries
   `cloudflare-api-token` and `cloudflare-r2-tfstate` (JSON
   `{accessKeyId, secretAccessKey}`).
3. Read the account (`discover.ts`), and stop before terraform runs on
   anything that a plan would repoint or shadow: a project host under an
   Access application the config does not own (prod's sign-in application),
   an Access application over a tunnel's origin, a tunnel origin's record that
   points anywhere but its own tunnel, a route another Worker holds, a service
   token name that matches no token, two resources where the config names
   one, an origin of the Mac's with no proxied record, a project hostname no
   certificate covers.
4. Write the run's tfvars and the `-backend-config` file (bucket, key
   `cloudflare/<env>.tfstate`, endpoint) to `state/<env>/`, mode 600.
5. `terraform init` against the R2 state, then `plan`, or `apply`.
6. After a local apply, print each project's `CF_ACCESS_AUD` and
   `CF_ACCESS_HOST_AUDS`, for a server on the Mac.

The credentials reach terraform in its environment and nowhere else: never an
argument, a variable or a file, so neither is in the state.

**The keeper.** The provider cannot send the keeper's request header, so
terraform never goes through the keeper. That is why CI is the main path: the
GitHub secret holds the token. A local `cf:plan` is optional and needs a token
in the Keychain's `cloudflare-api-token`, which the keeper's runbook deletes
(`docs/process/keeper.md`, section 5). There is no keeper route for terraform.

**Adopting what exists.** `deploys/prod/imports.tf` imports each live resource
`discover.ts` found by the name this config gives it, so the first apply
updates it in place rather than making a second one. An import of a resource
already in state does nothing. Read the first plan closely: an adopted
resource shows every field the config sets differently. The share-link
Worker's workers.dev address is not managed, so it stays as it is.

**Removing.** An entry removed from a config is destroyed at the next apply,
and the plan lists it as a destroy first. Access applications and tunnels
carry `prevent_destroy`, so a plan that would remove or replace one fails.
To remove one on purpose, take its `lifecycle` block off in a reviewed
change first.

## CI

`.github/workflows/cloudflare.yml` runs on changes under `infra/cloudflare/`,
to either Worker's `worker.js`, or to itself:

- **Pull request:** `check:cloudflare-tf`, then `run.ts plan prod --ci`, which
  saves the plan, takes no state lock, and posts a summary to the PR. The plan
  job is skipped, not failed, when its secrets are absent (a fork's PR).
- **Push to main:** the same check, then `run.ts apply prod --ci` in the
  GitHub Environment `cloudflare-prod` (concurrency group `cloudflare-prod`,
  never cancelled midway), then `machine:deploy` for each machine in
  `infra/project-machine/machines.json` (concurrency group `fly-prod`).

The repo is public, so its logs and comments are too. With `--ci`,
terraform's own output is not printed. A plan is reported as resource
addresses and verbs only (`plan-summary.ts`), and addresses carry project
labels and Worker names, never a hostname: routes and records are keyed by
label. terraform's errors still print.

Each credential is set twice under one name. The repository's copy is
read-only, for pull request plans. The `cloudflare-prod` environment's copy
can write, and GitHub gives it precedence in the jobs that use that
environment. If the environment's copy is missing, apply runs with the
read-only one and fails.

| Secret | Repository | `cloudflare-prod` |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | read-only token | the apply token (permissions below) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Object Read on the state bucket | Object Read and Write on the state bucket |
| `CF_ROUTER_CONFIG`, `CF_ACCESS_CONFIG`, `CF_SHARE_LINK_CONFIG` | the three configs' contents (they hold the Access email lists) | |
| `CLOUDFLARE_ACCOUNT_ID` | | names the R2 endpoint for `machine:deploy`'s output read |
| `FLY_API_TOKEN` | | the Fly org token |
| `CW_BOARD_OWNER_EMAIL` | | each server's `CW_OWNER_EMAIL` |

The jobs hand the R2 pair to terraform as `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`, the names the S3 backend reads. `CF_TFSTATE_BUCKET`
is an optional repository variable; the default bucket is
`claude-workspaces-tfstate`. `cloudflare-prod` must allow deployments from
`main` only: that rule keeps its write tokens out of a pull request's reach,
including one that edits this workflow.

## State

Remote, in a private R2 bucket shared by CI and the Mac, one key per
environment (`cloudflare/prod.tfstate`, `cloudflare/staging.tfstate`), through
terraform's S3 backend. The committed backend block holds only the settings R2
needs; the bucket, key and endpoint come from `state/<env>/backend.hcl`, which
the wrapper writes. `use_lockfile` takes a lock object beside the state for
each apply, so the Mac and CI cannot apply at once.

The state holds hostnames, ids, the Access email lists, and each project
machine's tunnel token (`modules/tunnel`: `machine:deploy` reads the token
from `terraform output tunnel_tokens`, which is sensitive). Anyone who can
read the bucket can read those tokens, so the bucket's R2 tokens are its only
credentials and the read-only pair is used wherever a write is not needed.

## The token's permissions

On the account: Access: Apps and Policies Edit, Access: Service Tokens Read,
Access: Organizations Read, Cloudflare Tunnel Edit (the tunnel token read
needs it), Workers Scripts Edit. On the zone: Zone Read, DNS Edit, SSL and
Certificates Read, Workers Routes Edit. The plan token has the Read form of
each.

## Fly, after the apply

`deploy-machines` runs `bun infra/project-machine/machines.ts deploy`, which
runs `machine:deploy` for each machine listed in `machines.json`. There,
`machine:deploy` runs with `CW_SECRETS_FROM_ENV=1` (`mac-ops.ts`): every
Keychain entry it would read is an environment variable instead
(`fly-org-slug` becomes `CW_SECRET_FLY_ORG_SLUG`), the org token is
`FLY_API_TOKEN`, and no Keychain entry can be made. So CI only updates a
machine the Mac already made; a run that would make an app, a volume or a
credential is refused before any change. The tunnel, its token and the Access
settings come from `terraform output` (`outputs.ts`), so `machine:deploy`
makes no Cloudflare call.

## Tests

`bun run check:cloudflare-tf`, a member of `bun run verify`, a step of CI's
`gates` job and the first job of `cloudflare.yml`: `terraform fmt -check`,
`terraform validate` on each root, and `deploys/prod/tests/plan.tftest.hcl`,
which plans the root and each module from a fixture against a mock provider
(no token, no state, no network call beyond the provider download).
In `packages/server/test`: `cloudflare-tf-discover.test.ts` runs the adoption
and the refusals against a fake account; `cloudflare-tf-wrapper.test.ts` the
variable assembly, where each credential goes, what CI prints, and the file
modes; `cloudflare-tf-outputs.test.ts` the credential sources, the plan
summary and the outputs `machine:deploy` reads. What only the real account
can show: the import id formats (read from the provider's own documentation
strings; the mock provider cannot run an import), R2's acceptance of the
lock file, and the first plan's diff.
