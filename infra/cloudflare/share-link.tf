# The share-link edge Worker (infra/share-link-worker/README.md), on
# `<host>/share/*` routes only. Managed only when
# infra/share-link-worker/wrangler.local.toml lists routes.
#
# Its HMAC key stays a Worker secret set with `wrangler secret put
# SHARE_LINK_KEY`: `keep_bindings` keeps that secret across an apply, so the
# key never enters this config or its state. Observability stays off, because
# request logs would carry full signed URLs.

locals {
  share_link_scripts = length(var.share_link_routes) > 0 ? toset(["share-link-gate"]) : toset([])
}

resource "cloudflare_workers_script" "share_link" {
  for_each           = local.share_link_scripts
  account_id         = var.account_id
  script_name        = each.key
  main_module        = "worker.js"
  content            = file("${path.module}/../share-link-worker/worker.js")
  compatibility_date = "2026-08-01"
  keep_bindings      = ["secret_text"]
  observability      = { enabled = false }
}

resource "cloudflare_workers_script_subdomain" "share_link" {
  for_each         = local.share_link_scripts
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.share_link[each.key].script_name
  enabled          = false
  previews_enabled = false
}

resource "cloudflare_workers_route" "share_link" {
  for_each = toset(var.share_link_routes)
  zone_id  = var.zone_id
  pattern  = each.value
  script   = cloudflare_workers_script.share_link["share-link-gate"].script_name
}
