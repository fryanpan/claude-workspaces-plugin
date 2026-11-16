# Local state, never the shared R2 bucket: the state holds the key string.
# Pass the path at init, outside every checkout, so deleting a worktree
# cannot lose it (README.md, "State").
terraform {
  backend "local" {}
}
