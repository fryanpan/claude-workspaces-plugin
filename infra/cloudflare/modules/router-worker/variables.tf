variable "account_id" {
  description = "The account the Worker lives in."
  type        = string
}

variable "zone_id" {
  description = "The zone of every route and record."
  type        = string
}

variable "script_name" {
  description = "The Worker's name in the account."
  type        = string
}

variable "worker_source" {
  description = "Path to the Worker's module, infra/board-router-worker/worker.js."
  type        = string
}

variable "compatibility_date" {
  description = "The Workers runtime's compatibility date."
  type        = string
  default     = "2026-08-01"
}

variable "one_address" {
  description = "The one address: one level under the zone. The Worker's ONE_ADDRESS."
  type        = string
}

variable "project_origins" {
  description = "Project label -> origin hostname: the Worker's PROJECT_ORIGINS."
  type        = map(string)
}

variable "project_hosts" {
  description = "Project label -> the project's own hostname."
  type        = map(string)
}

variable "board_origins" {
  description = "Origin hostname -> board ids: the Worker's BOARD_ORIGINS."
  type        = map(list(string))
  default     = {}
}

variable "bind_board_paths" {
  description = "Bind `<one address>/workspaces/*` to the Worker too."
  type        = bool
  default     = false
}

variable "one_address_origin" {
  description = "The Worker's ONE_ADDRESS_ORIGIN; empty leaves it unset."
  type        = string
  default     = ""
}
