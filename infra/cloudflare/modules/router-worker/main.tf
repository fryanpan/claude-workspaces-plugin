# The board router Worker (infra/board-router-worker/README.md): one route
# per project hostname, so no name the table does not list reaches it, plus
# `<one address>/workspaces/*` once `bind_board_paths` is on. Each project
# hostname resolves through a proxied AAAA record to `100::`, the documented
# placeholder for a name only a Worker answers. The Worker has no workers.dev
# address and no preview URLs, so it answers only on its routes, behind Access.
#
# Routes are keyed by project label, and the one address's board paths by
# BOARD_PATHS_KEY, so a resource address never carries a hostname.

locals {
  board_paths_key = "one-address/workspaces"

  routes = merge(
    { for label, host in var.project_hosts : label => "${host}/*" },
    var.bind_board_paths ? { (local.board_paths_key) = "${var.one_address}/workspaces/*" } : {},
  )

  bindings = concat(
    [
      { name = "ONE_ADDRESS", type = "plain_text", text = var.one_address },
      { name = "PROJECT_ORIGINS", type = "plain_text", text = jsonencode(var.project_origins) },
      { name = "BOARD_ORIGINS", type = "plain_text", text = jsonencode(var.board_origins) },
    ],
    var.one_address_origin == "" ? [] : [
      { name = "ONE_ADDRESS_ORIGIN", type = "plain_text", text = var.one_address_origin },
    ],
  )
}

resource "cloudflare_workers_script" "router" {
  account_id         = var.account_id
  script_name        = var.script_name
  main_module        = "worker.js"
  content            = file(var.worker_source)
  compatibility_date = var.compatibility_date
  bindings           = local.bindings
  observability      = { enabled = false }
}

resource "cloudflare_workers_script_subdomain" "router" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.router.script_name
  enabled          = false
  previews_enabled = false
}

resource "cloudflare_workers_route" "router" {
  for_each = local.routes
  zone_id  = var.zone_id
  pattern  = each.value
  script   = cloudflare_workers_script.router.script_name
}

resource "cloudflare_dns_record" "project_host" {
  for_each = var.project_hosts
  zone_id  = var.zone_id
  name     = each.value
  type     = "AAAA"
  content  = "100::"
  proxied  = true
  ttl      = 1
  comment  = "A project's own hostname, answered by the ${var.script_name} Worker"
}
