# The sign-in test app's Cloudflare side (infra/signin-test/README.md): its
# D1 database, its Turnstile widget, its Worker's custom domain, and the DNS
# records Resend needs to send from the mail subdomain. The Worker's code is
# wrangler's: Terraform makes a placeholder script once, so the custom domain
# has something to point at on the first run, and then never touches it.
#
# Applied only by `.github/workflows/signin-test.yml`, through deploy.ts, with
# the `cloudflare-prod` deploy token. Its state holds the Turnstile widget's
# secret, because the provider reads it back; that state is its own key in the
# R2 bucket, never prod's.

provider "cloudflare" {}

data "cloudflare_zone" "app" {
  filter = {
    name    = var.zone_name
    account = { id = var.account_id }
  }
}

locals {
  zone_id      = data.cloudflare_zone.app.id
  mail_records = { for r in var.mail_records : r.key => r }
}

resource "cloudflare_d1_database" "app" {
  account_id = var.account_id
  name       = var.app_name

  # The users and their sessions live here.
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_turnstile_widget" "app" {
  account_id = var.account_id
  name       = var.app_name
  domains    = [var.hostname]
  mode       = "managed"
}

resource "cloudflare_workers_script" "app" {
  account_id         = var.account_id
  script_name        = var.app_name
  main_module        = "placeholder.js"
  content            = "export default { fetch() { return new Response('Not deployed yet', { status: 503 }); } };"
  compatibility_date = "2026-11-01"

  # wrangler deploys the real code, its bindings and its secrets.
  lifecycle {
    ignore_changes = all
  }
}

resource "cloudflare_workers_custom_domain" "app" {
  account_id = var.account_id
  zone_id    = local.zone_id
  hostname   = var.hostname
  service    = cloudflare_workers_script.app.script_name
}

resource "cloudflare_dns_record" "mail" {
  for_each = local.mail_records

  zone_id  = local.zone_id
  name     = each.value.name
  type     = each.value.type
  content  = each.value.content
  priority = each.value.type == "MX" ? each.value.priority : null
  ttl      = 1
  proxied  = false
  comment  = "Resend sending for ${var.app_name}"
}
