# The share-link edge Worker (infra/share-link-worker/README.md), on
# `<host>/share/*` routes only. Made only when routes are listed.
#
# Its HMAC key stays a Worker secret set with `wrangler secret put
# SHARE_LINK_KEY`: `keep_bindings` keeps that secret across an apply, so the
# key never enters this config or its state. Observability stays off, because
# request logs would carry full signed URLs. Its workers.dev address is left
# as it is: this config does not manage it, so adopting the Worker changes
# nothing there.

locals {
  scripts = length(var.routes) > 0 ? toset([var.script_name]) : toset([])
}

resource "cloudflare_workers_script" "share_link" {
  for_each           = local.scripts
  account_id         = var.account_id
  script_name        = each.key
  main_module        = "worker.js"
  content            = file(var.worker_source)
  compatibility_date = var.compatibility_date
  keep_bindings      = ["secret_text"]
  observability      = { enabled = false }
}

resource "cloudflare_workers_route" "share_link" {
  for_each = var.routes
  zone_id  = var.zone_id
  pattern  = each.value
  script   = cloudflare_workers_script.share_link[var.script_name].script_name
}
