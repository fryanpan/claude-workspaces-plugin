output "tunnels" {
  description = "Project label -> its tunnel's id and names. No credential."
  value = {
    for label, t in var.tunnels : label => {
      account_id  = var.account_id
      id          = cloudflare_zero_trust_tunnel_cloudflared.project[label].id
      name        = t.name
      origin      = t.origin
      public_host = t.public_host
    }
  }
}
