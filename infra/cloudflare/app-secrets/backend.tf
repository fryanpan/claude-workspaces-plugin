# Local state, never the shared R2 bucket. A GitHub secret's value sits in
# the state, and every same-repo pull request's plan holds a key that reads
# the whole state bucket (README.md, "CI"). The wrapper (`../app-secrets.ts`)
# passes the path at init: a folder of mode 700 under `$CW_TF_WORK_DIR` when
# that is set, else `~/.local/state/claude-workspaces/app-secrets/`, outside
# every checkout.
terraform {
  backend "local" {}
}
