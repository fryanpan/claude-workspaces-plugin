variable "account_id" {
  description = "The account the applications and policies live in."
  type        = string
}

variable "name_prefix" {
  description = "Put before every name, so two environments in one account do not collide. Empty for prod."
  type        = string
  default     = ""
}

variable "session_duration" {
  description = "How long an Access sign-in lasts, e.g. 24h."
  type        = string
}

variable "projects" {
  description = "Project label -> the hostnames its application covers and who it admits."
  type = map(object({
    hosts          = list(string)
    emails         = list(string)
    email_domains  = list(string)
    service_tokens = list(string)
  }))
}

variable "service_token_ids" {
  description = "Access service token name -> id."
  type        = map(string)
  default     = {}
}
