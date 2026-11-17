variable "project" {
  description = "The Workspaces GCP project id. The key and the two enabled APIs live there."
  type        = string
}

variable "allowed_referrers" {
  description = "The pages allowed to use the key, as Google's referrer patterns (host/path, * as a wildcard). The real hostnames go in a gitignored tfvars file or on the command line."
  type        = list(string)

  validation {
    condition     = length(var.allowed_referrers) > 0
    error_message = "allowed_referrers must name at least one page; an empty list would leave the key usable from any site."
  }
}

variable "display_name" {
  description = "The key's name, as the console lists it."
  type        = string
  default     = "workspaces maps (browser)"
}

variable "key_file" {
  description = "Where to write the key for the server on this machine to read at boot. The server reads this path unless CW_GOOGLE_MAPS_KEY or CW_GOOGLE_MAPS_KEY_FILE says otherwise (packages/server/src/google-maps-key.ts)."
  type        = string
  default     = "~/Library/Application Support/claude-workspaces/google-maps-key"
}
