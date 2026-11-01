# One environment's whole Cloudflare configuration: the four modules wired
# together. Each root under deploys/ calls this once with that environment's
# values; nothing here names a real account, zone, host or person.

locals {
  # Keyed by the host without the zone, so an address carries no zone name.
  share_link_routes = {
    for p in var.share_link_routes : trimsuffix(trimsuffix(p, "/share/*"), ".${var.zone}") => p
  }
}

module "access" {
  source            = "../access"
  account_id        = var.account_id
  name_prefix       = var.name_prefix
  session_duration  = var.access_session_duration
  projects          = var.access_projects
  service_token_ids = var.service_token_ids
}

module "router" {
  source             = "../router-worker"
  account_id         = var.account_id
  zone_id            = var.zone_id
  script_name        = var.router_script_name
  worker_source      = "${path.module}/../../../board-router-worker/worker.js"
  one_address        = var.one_address
  project_origins    = var.project_origins
  project_hosts      = var.project_hosts
  board_origins      = var.board_origins
  bind_board_paths   = var.bind_board_paths
  one_address_origin = var.one_address_origin
}

module "share_link" {
  source        = "../share-link"
  account_id    = var.account_id
  zone_id       = var.zone_id
  script_name   = var.share_link_script_name
  worker_source = "${path.module}/../../../share-link-worker/worker.js"
  routes        = local.share_link_routes
}

module "tunnel" {
  source     = "../tunnel"
  account_id = var.account_id
  zone_id    = var.zone_id
  tunnels    = var.tunnels
}

# The Access organization's team domain, which every project server needs
# as CF_ACCESS_TEAM_DOMAIN. Read, never managed.
data "cloudflare_zero_trust_organization" "this" {
  account_id = var.account_id
}
