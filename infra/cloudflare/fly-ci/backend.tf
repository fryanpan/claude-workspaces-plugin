# Local state, never the shared R2 bucket. A deploy token's value sits in the
# state, and every same-repo pull request's plan holds a key that reads the
# whole state bucket (README.md, "CI"). The wrapper
# (`infra/project-machine/ci-tokens.ts`) passes the path at init:
# `~/.local/state/claude-workspaces/fly-ci/` (or `$CW_TF_WORK_DIR/fly-ci`),
# outside every checkout, mode 700.
terraform {
  backend "local" {}
}
