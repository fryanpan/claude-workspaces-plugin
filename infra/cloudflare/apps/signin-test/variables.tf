# Every value comes from `infra/signin-test/deploy.ts`: the names from its
# APP constant, the account from ci-credentials.ts, and mail_records from
# Resend's answer for the sending domain.

variable "account_id" {
  description = "The Cloudflare account the app lives in."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be 32 hex digits."
  }
}

variable "app_name" {
  description = "The Worker's name, which the D1 database and the Turnstile widget share."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,62}$", var.app_name))
    error_message = "app_name must be lower-case letters, digits and dashes."
  }
}

variable "zone_name" {
  description = "The Cloudflare zone both hostnames sit in."
  type        = string
}

variable "hostname" {
  description = "The app's public hostname, served by the Worker as a custom domain."
  type        = string

  validation {
    condition     = endswith(var.hostname, ".${var.zone_name}")
    error_message = "hostname must be a subdomain of zone_name."
  }
}

variable "mail_domain" {
  description = "The subdomain mail is sent from. Every mail record must sit at or under it, so the zone's own mail records are never touched."
  type        = string

  validation {
    condition     = endswith(var.mail_domain, ".${var.zone_name}")
    error_message = "mail_domain must be a subdomain of zone_name, never the zone itself."
  }
}

variable "mail_records" {
  description = "The DNS records Resend asks for, each name fully qualified. key is a stable label for the resource address, which a public log prints."
  type = list(object({
    key      = string
    type     = string
    name     = string
    content  = string
    priority = optional(number)
  }))
  default = []

  validation {
    condition = alltrue([
      for r in var.mail_records : r.name == var.mail_domain || endswith(r.name, ".${var.mail_domain}")
    ])
    error_message = "every mail record must sit at or under mail_domain."
  }

  validation {
    condition     = alltrue([for r in var.mail_records : contains(["TXT", "MX", "CNAME"], r.type)])
    error_message = "a mail record is TXT, MX or CNAME."
  }

  validation {
    condition     = length(distinct([for r in var.mail_records : r.key])) == length(var.mail_records)
    error_message = "each mail record needs its own key."
  }
}
