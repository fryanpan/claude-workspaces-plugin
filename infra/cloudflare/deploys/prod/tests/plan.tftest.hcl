# What each module plans from a fixture, against a mock provider: no token,
# no account, no state, no network call. Run by `bun run check:cloudflare-tf`.
# Each run plans one module (`module { source }`), because an assertion can
# only read the resources of the module under test.

mock_provider "cloudflare" {}

variables {
  account_id  = "0123456789abcdef0123456789abcdef"
  zone_id     = "fedcba9876543210fedcba9876543210"
  zone        = "harborlight.test"
  one_address = "workspaces.harborlight.test"
  project_origins = {
    riverbend = "riverbend-origin.harborlight.test"
    saltmarsh = "mac-origin.harborlight.test"
  }
  project_hosts = {
    riverbend = "riverbend-workspaces.harborlight.test"
    saltmarsh = "saltmarsh-workspaces.harborlight.test"
  }
  tunnels = {
    riverbend = {
      name        = "cw-riverbend"
      origin      = "riverbend-origin.harborlight.test"
      public_host = "riverbend-workspaces.harborlight.test"
    }
  }
  access_projects = {
    riverbend = {
      hosts          = ["riverbend-workspaces.harborlight.test"]
      emails         = ["alice@harborlight.test"]
      email_domains  = ["riverbend.test"]
      service_tokens = ["relay riverbend"]
    }
    saltmarsh = {
      hosts          = ["saltmarsh-workspaces.harborlight.test"]
      emails         = []
      email_domains  = []
      service_tokens = []
    }
  }
  service_token_ids      = { "relay riverbend" = "token-1" }
  name_prefix            = ""
  router_script_name     = "board-router"
  share_link_script_name = "share-link-gate"
}

run "the_root_plans_and_keys_routes_without_hostnames" {
  command = plan

  variables {
    share_link_routes = ["share.harborlight.test/share/*"]
  }

  assert {
    condition     = keys(module.stack.router_routes) == ["riverbend", "saltmarsh"]
    error_message = "router routes are keyed by project label"
  }

  assert {
    condition     = module.stack.share_link_routes == { share = "share.harborlight.test/share/*" }
    error_message = "a share route is keyed by its host without the zone"
  }
}

run "router_binds_one_route_per_project_and_not_the_one_address" {
  command = plan

  module {
    source = "../../modules/router-worker"
  }

  variables {
    script_name   = "board-router"
    worker_source = "../../../board-router-worker/worker.js"
  }

  assert {
    condition = { for k, r in cloudflare_workers_route.router : k => r.pattern } == {
      riverbend = "riverbend-workspaces.harborlight.test/*"
      saltmarsh = "saltmarsh-workspaces.harborlight.test/*"
    }
    error_message = "the router must bind exactly one route per project hostname"
  }

  assert {
    condition     = cloudflare_workers_script_subdomain.router.enabled == false
    error_message = "the router must have no workers.dev address"
  }

  assert {
    condition     = cloudflare_dns_record.project_host["riverbend"].content == "100::" && cloudflare_dns_record.project_host["riverbend"].proxied
    error_message = "a project hostname is a proxied AAAA placeholder"
  }

  assert {
    condition     = tomap(jsondecode(nonsensitive([for b in cloudflare_workers_script.router.bindings : b.text if b.name == "PROJECT_ORIGINS"][0]))) == var.project_origins
    error_message = "the Worker carries PROJECT_ORIGINS as JSON it can parse"
  }

  assert {
    condition     = length([for b in cloudflare_workers_script.router.bindings : b if b.name == "ONE_ADDRESS_ORIGIN"]) == 0
    error_message = "ONE_ADDRESS_ORIGIN is absent when unset"
  }
}

run "board_paths_are_bound_only_when_asked" {
  command = plan

  module {
    source = "../../modules/router-worker"
  }

  variables {
    script_name        = "board-router"
    worker_source      = "../../../board-router-worker/worker.js"
    bind_board_paths   = true
    board_origins      = { "mac-origin.harborlight.test" = ["b1"] }
    one_address_origin = "mac-origin.harborlight.test"
  }

  assert {
    condition     = cloudflare_workers_route.router["one-address/workspaces"].pattern == "workspaces.harborlight.test/workspaces/*"
    error_message = "bind_board_paths adds the one address's board paths"
  }

  assert {
    condition     = nonsensitive([for b in cloudflare_workers_script.router.bindings : b.text if b.name == "ONE_ADDRESS_ORIGIN"]) == ["mac-origin.harborlight.test"]
    error_message = "ONE_ADDRESS_ORIGIN reaches the Worker when set"
  }
}

run "a_project_with_nobody_listed_admits_no_person" {
  command = plan

  module {
    source = "../../modules/access"
  }

  variables {
    session_duration = "24h"
    projects         = var.access_projects
  }

  assert {
    condition     = toset(keys(cloudflare_zero_trust_access_policy.people)) == toset(["riverbend"])
    error_message = "only a project with people or domains gets an allow policy"
  }

  assert {
    condition     = length(cloudflare_zero_trust_access_application.project["saltmarsh"].policies) == 0
    error_message = "an application with nobody listed has no policy"
  }

  assert {
    condition     = length(cloudflare_zero_trust_access_application.project["riverbend"].policies) == 2
    error_message = "people and service tokens are two policies"
  }

  assert {
    condition     = cloudflare_zero_trust_access_policy.service_tokens["riverbend"].decision == "non_identity"
    error_message = "service tokens are admitted by a non_identity policy, never as a person"
  }

  assert {
    condition     = [for r in cloudflare_zero_trust_access_policy.service_tokens["riverbend"].include : r.service_token.token_id] == ["token-1"]
    error_message = "a service token name resolves to its id"
  }

  assert {
    condition     = cloudflare_zero_trust_access_application.project["riverbend"].name == "board riverbend" && cloudflare_zero_trust_access_application.project["riverbend"].domain == "riverbend-workspaces.harborlight.test"
    error_message = "the application is named board <project> over its first host"
  }
}

run "staging_names_do_not_collide_with_prod" {
  command = plan

  module {
    source = "../../modules/access"
  }

  variables {
    session_duration = "24h"
    projects         = var.access_projects
    name_prefix      = "staging "
  }

  assert {
    condition     = cloudflare_zero_trust_access_application.project["riverbend"].name == "staging board riverbend" && cloudflare_zero_trust_access_policy.people["riverbend"].name == "staging riverbend people"
    error_message = "the name prefix reaches every Access name"
  }
}

run "a_tunnel_sends_its_project_host_to_the_server_and_all_else_to_a_404" {
  command = plan

  module {
    source = "../../modules/tunnel"
  }

  assert {
    condition     = keys(cloudflare_zero_trust_tunnel_cloudflared.project) == ["riverbend"]
    error_message = "a tunnel exists only for a project machine"
  }

  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.project["riverbend"].config.ingress[0].hostname == "riverbend-workspaces.harborlight.test" && cloudflare_zero_trust_tunnel_cloudflared_config.project["riverbend"].config.ingress[0].service == "http://localhost:8787" && cloudflare_zero_trust_tunnel_cloudflared_config.project["riverbend"].config.ingress[1].service == "http_status:404"
    error_message = "the ingress is the project hostname, then a 404"
  }

  assert {
    condition     = cloudflare_dns_record.origin["riverbend"].type == "CNAME" && cloudflare_dns_record.origin["riverbend"].proxied
    error_message = "the origin is a proxied CNAME"
  }
}

run "no_share_link_worker_without_routes" {
  command = plan

  module {
    source = "../../modules/share-link"
  }

  variables {
    script_name   = "share-link-gate"
    worker_source = "../../../share-link-worker/worker.js"
  }

  assert {
    condition     = length(cloudflare_workers_script.share_link) == 0
    error_message = "no share-link Worker is made until routes are listed"
  }
}

run "the_share_link_worker_keeps_its_secret" {
  command = plan

  module {
    source = "../../modules/share-link"
  }

  variables {
    script_name   = "share-link-gate"
    worker_source = "../../../share-link-worker/worker.js"
    routes        = { share = "share.harborlight.test/share/*" }
  }

  assert {
    condition     = cloudflare_workers_script.share_link["share-link-gate"].keep_bindings == toset(["secret_text"])
    error_message = "an apply must keep the SHARE_LINK_KEY secret"
  }

  assert {
    condition     = { for k, r in cloudflare_workers_route.share_link : k => r.pattern } == { share = "share.harborlight.test/share/*" }
    error_message = "the share-link Worker binds only its /share/* routes"
  }
}
