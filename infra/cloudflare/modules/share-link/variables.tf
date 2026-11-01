variable "account_id" {
  description = "The account the Worker lives in."
  type        = string
}

variable "zone_id" {
  description = "The zone of every route."
  type        = string
}

variable "script_name" {
  description = "The Worker's name in the account."
  type        = string
}

variable "worker_source" {
  description = "Path to the Worker's module, infra/share-link-worker/worker.js."
  type        = string
}

variable "compatibility_date" {
  description = "The Workers runtime's compatibility date."
  type        = string
  default     = "2026-08-01"
}

variable "routes" {
  description = "Route key -> a `<host>/share/*` pattern. Empty makes no Worker."
  type        = map(string)
  default     = {}
}
