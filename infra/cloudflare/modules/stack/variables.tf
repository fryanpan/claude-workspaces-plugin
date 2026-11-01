variable "account_id" {
  description = "The account that owns the zone."
  type        = string
}

variable "zone_id" {
  description = "The zone every hostname lives in."
  type        = string
}

variable "zone" {
  description = "The zone's name."
  type        = string
}

variable "one_address" {
  description = "The one address: one level under the zone."
  type        = string
}

variable "project_origins" {
  description = "Project label -> origin hostname: the Worker's PROJECT_ORIGINS."
  type        = map(string)
  default     = {}
}

variable "project_hosts" {
  description = "Project label -> `<label>-<first label of the one address>.<zone>`."
  type        = map(string)
  default     = {}
}

variable "board_origins" {
  description = "Origin hostname -> board ids: the Worker's BOARD_ORIGINS."
  type        = map(list(string))
  default     = {}
}

variable "bind_board_paths" {
  description = "Bind `<one address>/workspaces/*` to the router Worker too."
  type        = bool
  default     = false
}

variable "one_address_origin" {
  description = "The Worker's ONE_ADDRESS_ORIGIN; empty leaves it unset."
  type        = string
  default     = ""
}

variable "tunnels" {
  description = "Project label -> the named tunnel of its Fly machine."
  type = map(object({
    name        = string
    origin      = string
    public_host = string
  }))
  default = {}
}

variable "access_session_duration" {
  description = "How long an Access sign-in lasts, e.g. 24h."
  type        = string
  default     = "24h"
}

variable "access_projects" {
  description = "Project label -> the hostnames its Access application covers and who it admits."
  type = map(object({
    hosts          = list(string)
    emails         = list(string)
    email_domains  = list(string)
    service_tokens = list(string)
  }))
  default = {}
}

variable "service_token_ids" {
  description = "Access service token name -> id, read from the account."
  type        = map(string)
  default     = {}
}

variable "share_link_routes" {
  description = "Route patterns of the share-link Worker; empty manages no share-link Worker."
  type        = list(string)
  default     = []
}

variable "name_prefix" {
  description = "Put before every Access name, so environments sharing an account do not collide."
  type        = string
}

variable "router_script_name" {
  description = "The board router Worker's name."
  type        = string
}

variable "share_link_script_name" {
  description = "The share-link Worker's name."
  type        = string
}
