# Read back by `cf:apply` and by `machine:deploy` (`infra/cloudflare/outputs.ts`).
# Only `tunnel_tokens` is a credential, and it is sensitive.

output "access" {
  description = "Project label -> its Access application's audience and hostnames."
  value       = module.access.projects
}

output "access_team_domain" {
  description = "The Access organization's team domain (CF_ACCESS_TEAM_DOMAIN)."
  value       = data.cloudflare_zero_trust_organization.this.auth_domain
}

output "tunnels" {
  description = "Project label -> its named tunnel's id and names."
  value       = module.tunnel.tunnels
}

output "tunnel_tokens" {
  description = "Project label -> its tunnel's token (CLOUDFLARE_TUNNEL_TOKEN)."
  sensitive   = true
  value       = module.tunnel.tokens
}

output "router_routes" {
  description = "Route key -> pattern of the board router Worker."
  value       = module.router.routes
}

output "share_link_routes" {
  description = "Route key -> pattern of the share-link Worker."
  value       = module.share_link.routes
}
