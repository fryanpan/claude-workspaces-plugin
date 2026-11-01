# The prod environment's Cloudflare configuration. Run it through
# `bun run cf:plan prod` / `bun run cf:apply prod` (README.md), which
# assemble the variables and put the credentials into terraform's
# environment only.
# On main, CI applies it (.github/workflows/cloudflare.yml).

# The token comes from CLOUDFLARE_API_TOKEN in terraform's environment. It is
# never a variable, so it never enters the state.
provider "cloudflare" {}

module "stack" {
  source                  = "../../modules/stack"
  account_id              = var.account_id
  zone_id                 = var.zone_id
  zone                    = var.zone
  one_address             = var.one_address
  project_origins         = var.project_origins
  project_hosts           = var.project_hosts
  board_origins           = var.board_origins
  bind_board_paths        = var.bind_board_paths
  one_address_origin      = var.one_address_origin
  tunnels                 = var.tunnels
  access_session_duration = var.access_session_duration
  access_projects         = var.access_projects
  service_token_ids       = var.service_token_ids
  share_link_routes       = var.share_link_routes
  name_prefix             = var.name_prefix
  router_script_name      = var.router_script_name
  share_link_script_name  = var.share_link_script_name
}
