# Each Fly project machine's named tunnel (docs/process/project-machine.md,
# "The tunnel"): the tunnel `cw-<project>`, configured from Cloudflare, whose
# one ingress rule sends the project's own hostname to the server on
# localhost:8787 and everything else to a 404, and the origin hostname
# `<project>-origin.<zone>`, a proxied CNAME to the tunnel with no Access
# application on it, which the router Worker resolves the project's hostname
# to.
#
# The tunnel's token is not here. `machine:deploy` reads it from Cloudflare
# when it sets the machine's CLOUDFLARE_TUNNEL_TOKEN, so the credential never
# enters this state.

resource "cloudflare_zero_trust_tunnel_cloudflared" "project" {
  for_each   = var.tunnels
  account_id = var.account_id
  name       = each.value.name
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "project" {
  for_each   = var.tunnels
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.project[each.key].id
  config = {
    ingress = [
      { hostname = each.value.public_host, service = "http://localhost:8787" },
      { service = "http_status:404" },
    ]
  }
}

resource "cloudflare_dns_record" "origin" {
  for_each = var.tunnels
  zone_id  = var.zone_id
  name     = each.value.origin
  type     = "CNAME"
  content  = "${cloudflare_zero_trust_tunnel_cloudflared.project[each.key].id}.cfargotunnel.com"
  proxied  = true
  ttl      = 1
  comment  = "${each.value.name}: the origin the board router resolves ${each.value.public_host} to"
}
