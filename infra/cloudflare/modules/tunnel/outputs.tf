output "tunnels" {
  description = "Project label -> its tunnel's id and names. No credential."
  value = {
    for label, t in var.tunnels : label => {
      id          = cloudflare_zero_trust_tunnel_cloudflared.project[label].id
      name        = t.name
      origin      = t.origin
      public_host = t.public_host
    }
  }
}

output "tokens" {
  description = "Project label -> its tunnel's token, the machine's CLOUDFLARE_TUNNEL_TOKEN."
  sensitive   = true
  value       = { for label, t in data.cloudflare_zero_trust_tunnel_cloudflared_token.project : label => t.token }
}
