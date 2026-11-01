output "access" {
  description = "Project label -> its Access application's audience and hostnames."
  value       = module.stack.access
}

output "access_team_domain" {
  description = "The Access organization's team domain (CF_ACCESS_TEAM_DOMAIN)."
  value       = module.stack.access_team_domain
}

output "tunnels" {
  description = "Project label -> its named tunnel's id and names."
  value       = module.stack.tunnels
}

output "tunnel_tokens" {
  description = "Project label -> its tunnel's token (CLOUDFLARE_TUNNEL_TOKEN)."
  sensitive   = true
  value       = module.stack.tunnel_tokens
}
