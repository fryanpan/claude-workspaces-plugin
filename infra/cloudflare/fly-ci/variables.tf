variable "repository_owner" {
  description = "The GitHub owner of the repository whose environments this makes."
  type        = string
}

variable "repository" {
  description = "The repository's name, without the owner."
  type        = string
}

# Environment name -> the Fly token cut down to that environment's one app.
# `fly:ci-tokens` builds it (`infra/project-machine/ci-tokens.ts`) and hands
# it in as TF_VAR_deploy_tokens, never a file or an argument. A name left out
# deletes that environment and its token; the wrapper refuses that without
# --drop.
variable "deploy_tokens" {
  description = "Each fly-<project> environment to make, and the app-scoped Fly token it holds."
  type        = map(string)
  default     = {}
  sensitive   = true

  validation {
    condition     = alltrue([for name in nonsensitive(keys(var.deploy_tokens)) : can(regex("^fly-[a-z0-9][a-z0-9-]{0,40}$", name))])
    error_message = "Every environment is fly-<project>: lower case letters, digits and hyphens."
  }

  validation {
    condition     = alltrue([for v in values(var.deploy_tokens) : v != ""])
    error_message = "No token may be empty; leave its environment out instead."
  }
}

# The read-only token: every app and the org with read alone, no wg, so no
# `fly ssh` (`readCaveats` in ci-tokens.ts). It goes to `fly-org-read` as
# FLY_READ_TOKEN, where wall-read.yml's daily `fly apps list` reads with it
# instead of the org token. Empty makes no environment.
variable "read_token" {
  description = "The read-only Fly token for the fly-org-read environment; empty makes none."
  type        = string
  default     = ""
  sensitive   = true
}
