# Each Fly project machine's named tunnel (docs/process/project-machine.md,
# "The tunnel"): the tunnel, configured from Cloudflare, whose one ingress
# rule sends the project's own hostname to the server and everything else to
# a 404, and the origin hostname, a proxied CNAME to the tunnel with no Access
# application on it, which the router Worker resolves the project's hostname
# to.
#
# The tunnel's token is read back as a data source so `machine:deploy` takes
# it from `terraform output`. That puts the token in the state, which is why
# the state bucket is private and the output is sensitive (README, "State").

resource "cloudflare_zero_trust_tunnel_cloudflared" "project" {
  for_each   = var.tunnels
  account_id = var.account_id
  name       = each.value.name
  config_src = "cloudflare"

  # A remade tunnel has a new id and token: the machine stays offline until
  # it is redeployed with `--refresh-tunnel-token`. A plan that would destroy
  # one fails.
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "project" {
  for_each   = var.tunnels
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.project[each.key].id
  config = {
    ingress = [
      { hostname = each.value.public_host, service = var.service },
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

data "cloudflare_zero_trust_tunnel_cloudflared_token" "project" {
  for_each   = var.tunnels
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.project[each.key].id
}
