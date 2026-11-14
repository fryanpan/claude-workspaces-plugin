# Local state, never the shared R2 bucket. This state holds the CI deploy
# token's value, and every same-repo pull request's plan holds a key that
# reads the whole state bucket (README.md, "CI"). The wrapper
# (`../ci-secrets.ts`) passes the path at init: a folder of mode 700 under the
# keeper's work folder when the keeper runs it, else `../state/ci-secrets/`.
terraform {
  backend "local" {}
}
