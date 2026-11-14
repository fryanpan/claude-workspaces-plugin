variable "account_id" {
  description = "The Cloudflare account the CI token works in."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be 32 hex digits."
  }
}

variable "state_bucket" {
  description = "The R2 bucket that holds the prod and staging state. The token gets object read and write on it, and nothing else in R2."
  type        = string
  default     = "claude-workspaces-tfstate"
}

variable "token_name" {
  description = "The CI deploy token's name, as the dashboard lists it."
  type        = string
  default     = "claude-workspaces CI deploy"
}

variable "permission_groups" {
  description = "Cloudflare's permission groups (GET /user/tokens/permission_groups). Null reads them from Cloudflare; the tests give a fixture."
  type = list(object({
    id     = string
    name   = string
    scopes = list(string)
  }))
  default = null
}

variable "repository_owner" {
  description = "The GitHub owner of the repository whose Actions secrets this writes."
  type        = string
}

variable "repository" {
  description = "The repository's name, without the owner."
  type        = string
}

variable "environment" {
  description = "The GitHub Environment the deploy credentials go to. It must already exist and allow deployments from main only."
  type        = string
  default     = "cloudflare-prod"
}

# The three gitignored configs' contents. Each is written to a repository
# secret when set; null leaves that secret as it is.
variable "router_config" {
  description = "infra/board-router-worker/router.local.json, for CF_ROUTER_CONFIG."
  type        = string
  default     = null
  sensitive   = true
}

variable "access_config" {
  description = "infra/access-apps/access.local.json, for CF_ACCESS_CONFIG."
  type        = string
  default     = null
  sensitive   = true
}

variable "share_link_config" {
  description = "infra/share-link-worker/wrangler.local.toml, for CF_SHARE_LINK_CONFIG."
  type        = string
  default     = null
  sensitive   = true
}

variable "fly_api_token" {
  description = "A Fly deploy token for fly.yml, written to FLY_API_TOKEN in the environment when set. Fly has no maintained provider, so Terraform cannot make it."
  type        = string
  default     = null
  sensitive   = true
}
