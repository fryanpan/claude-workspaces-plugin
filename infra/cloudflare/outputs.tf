# Read back by the wrapper and by `machine:deploy`. None is a credential.

output "access_audiences" {
  description = "Project label -> its Access application's audience (CF_ACCESS_AUD)."
  value       = { for label, app in cloudflare_zero_trust_access_application.project : label => app.aud }
}

output "tunnels" {
  description = "Project label -> its named tunnel, for machine:deploy."
  value = {
    for label, t in var.tunnels : label => {
      id          = cloudflare_zero_trust_tunnel_cloudflared.project[label].id
      account_id  = var.account_id
      name        = t.name
      origin      = t.origin
      public_host = t.public_host
    }
  }
}
