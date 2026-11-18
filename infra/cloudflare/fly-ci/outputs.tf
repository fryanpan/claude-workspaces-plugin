# Names only: no token leaves this root as an output.

output "environments" {
  description = "The fly-<project> environments made, each holding FLY_DEPLOY_TOKEN."
  value       = sort(tolist(local.environments))
}
