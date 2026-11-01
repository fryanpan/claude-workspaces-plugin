# The board router Worker (infra/board-router-worker/README.md): one route
# per project hostname, so no name the table does not list reaches it, plus
# `<one address>/workspaces/*` once `bind_board_paths` is on. Each project
# hostname resolves through a proxied AAAA record to `100::`, the documented
# placeholder for a name only a Worker answers. The Worker has no workers.dev
# address and no preview URLs, so it answers only on its routes, behind Access.

locals {
  router_patterns = concat(
    [for host in values(var.project_hosts) : "${host}/*"],
    var.bind_board_paths ? ["${var.one_address}/workspaces/*"] : [],
  )

  router_bindings = concat(
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

resource "cloudflare_workers_script" "board_router" {
  account_id         = var.account_id
  script_name        = "board-router"
  main_module        = "worker.js"
  content            = file("${path.module}/../board-router-worker/worker.js")
  compatibility_date = "2026-08-01"
  bindings           = local.router_bindings
  observability      = { enabled = false }
}

resource "cloudflare_workers_script_subdomain" "board_router" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.board_router.script_name
  enabled          = false
  previews_enabled = false
}

resource "cloudflare_workers_route" "board_router" {
  for_each = toset(local.router_patterns)
  zone_id  = var.zone_id
  pattern  = each.value
  script   = cloudflare_workers_script.board_router.script_name
}

resource "cloudflare_dns_record" "project_host" {
  for_each = var.project_hosts
  zone_id  = var.zone_id
  name     = each.value
  type     = "AAAA"
  content  = "100::"
  proxied  = true
  ttl      = 1
  comment  = "A project's own hostname, answered by the board-router Worker"
}
