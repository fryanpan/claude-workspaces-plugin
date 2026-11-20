# Names only: no token leaves this root as an output.

output "environments" {
  description = "The fly-<project> environments made, each holding FLY_DEPLOY_TOKEN."
  value       = sort(tolist(local.environments))
}

output "read_environments" {
  description = "fly-org-read when a read token was handed in, holding FLY_READ_TOKEN."
  value       = sort(tolist(local.read_environments))
}
