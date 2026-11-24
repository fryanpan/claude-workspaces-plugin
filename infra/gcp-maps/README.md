# Google Maps browser key, in Terraform

The doc map loads Google Maps in the page, and that needs a browser API key.
This root makes the key and the two APIs it depends on, so nobody clicks
through the console or pastes a value. It is applied by hand, like
[`../cloudflare/ci-secrets`](../cloudflare/README.md#cis-credentials); CI
never runs it.

One apply makes:

| Resource | What it is |
| --- | --- |
| `google_project_service.apis["apikeys.googleapis.com"]` | The API Keys API, which Terraform uses to make the key |
| `google_project_service.apis["maps-backend.googleapis.com"]` | The Maps JavaScript API, the only API the key may call |
| `google_apikeys_key.maps_browser` | The key, named `workspaces maps (browser)`, restricted to the referrers you pass and to the Maps JavaScript API |
| `google_service_usage_consumer_quota_override.daily[...]` | The $5-a-day spend cap (Bryan, 19 Nov 2026): at most `daily_map_loads` (default 714) 2D map loads a day, at $7 per 1,000, and 0 3D loads. Past it Google refuses loads until midnight Pacific |
| `local_sensitive_file.maps_browser_key` | The key, written mode 600 to `key_file` on the machine that applies, for the server there to read at boot |

Destroying the root deletes the key and leaves both APIs on
(`disable_on_destroy = false`), because other things in the project may use
them.

## The key is public by design

A browser key ships in page JavaScript, so anyone who opens a page can read
it. It is not a secret, and leaking it is not an incident. Two restrictions
limit what it is good for: Google answers it only from a page whose referrer
matches `allowed_referrers`, and only for the Maps JavaScript API. An empty
referrer list would leave it usable from any site, so the variable refuses
one.

It is still not committed. The output is `sensitive`, and the key goes to
the server through the file below, not into the repository.

## How the server gets the key

Apply writes the key to `key_file`, by default
`~/Library/Application Support/claude-workspaces/google-maps-key`, mode 600.
That folder is prod's own root on the boot disk. The server reads the file once at boot
(`packages/server/src/google-maps-key.ts`), so the key reaches prod with no
edit to its launchd plist; restart the server after an apply that changes
the key. Apply on the machine that runs the server, or pass `key_file` for
another path there.

The server looks in this order:

1. `CW_GOOGLE_MAPS_KEY`, the key itself, when the environment sets it.
2. The file `CW_GOOGLE_MAPS_KEY_FILE` names, or else the default path above.

With neither, there is no key and every map draws on OpenStreetMap; a
missing file logs nothing. A file that is a link, not a plain file, owned by
another user, or not shaped like a key is skipped with a warning naming the
path.

## Inputs

| Variable | Value |
| --- | --- |
| `project` | The Workspaces GCP project id. No default |
| `allowed_referrers` | The pages that may use the key, as Google's referrer patterns: prod's board host, staging, and local dev. No default |
| `display_name` | Defaults to `workspaces maps (browser)` |
| `key_file` | Where the key is written for the server. Defaults to `~/Library/Application Support/claude-workspaces/google-maps-key` |

The real hostnames go on the command line or in a gitignored
`terraform.tfvars` here, never in a committed file.

## Credentials

The Google provider reads the operator's gcloud application-default login.
Nothing in this root holds a credential.

```bash
gcloud auth application-default login
```

The account needs, on the project, permission to enable services
(Service Usage Admin) and to make keys (API Keys Admin).

The project must have a billing account linked. Google refuses Maps
requests from a project without one, and this root does not link it.

## Running it

```bash
mkdir -p -m 700 ~/.local/state/claude-workspaces/gcp-maps
terraform -chdir=infra/gcp-maps init \
  -backend-config="path=$HOME/.local/state/claude-workspaces/gcp-maps/terraform.tfstate"
terraform -chdir=infra/gcp-maps apply \
  -var 'project=<workspaces-project-id>' \
  -var 'allowed_referrers=["workspaces.example.com/*","localhost:8788/*"]'
terraform -chdir=infra/gcp-maps output maps_browser_key_file
```

The first `init` after the `local` provider was added records it in
`.terraform.lock.hcl`; commit that change.

## State

**The state is local, and holds the key string.** Keep it in
`~/.local/state/claude-workspaces/gcp-maps/` (folder mode 700, files mode
600), outside every checkout, so deleting a worktree cannot lose it. It is
not in the shared R2 bucket: every same-repo pull request's plan holds a key
that reads that whole bucket. A lost state makes the next apply make a second
key and leave the first one active, so delete the old one in the console if
that happens.

`.gitignore` keeps `*.tfstate`, `*.tfstate.backup`, `*.tfplan`, this root's
`.terraform/` and its `*.tfvars` out of the repository. The lock file is
committed, with hashes for `darwin_arm64` and `linux_amd64`.
