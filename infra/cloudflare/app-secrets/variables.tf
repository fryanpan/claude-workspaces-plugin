variable "repository_owner" {
  description = "The GitHub owner of the repository whose Actions secrets this writes."
  type        = string
}

variable "repository" {
  description = "The repository's name, without the owner."
  type        = string
}

variable "environment" {
  description = "The GitHub Environment the secrets go to. It must already exist and allow deployments from main only."
  type        = string
  default     = "cloudflare-prod"
}

# Secret name -> value. `cf:app-secrets` builds it from APP_SECRETS
# (`../app-secrets.ts`) and hands it in as TF_VAR_secrets, never a file or an
# argument. A name left out deletes an earlier apply's copy; the wrapper
# refuses that without --drop.
variable "secrets" {
  description = "Each environment secret to write, by name."
  type        = map(string)
  default     = {}
  sensitive   = true

  validation {
    condition     = alltrue([for name in nonsensitive(keys(var.secrets)) : can(regex("^[A-Z][A-Z0-9_]*$", name))])
    error_message = "Every secret name is upper case letters, digits and underscores, starting with a letter."
  }

  validation {
    condition     = alltrue([for v in values(var.secrets) : v != ""])
    error_message = "No secret may be empty; leave its name out instead."
  }
}
