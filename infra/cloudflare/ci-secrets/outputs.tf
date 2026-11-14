# Names only, apart from the token's id, which is the R2 access key id and so
# is marked sensitive like every value here.

output "token_id" {
  description = "The CI deploy token's id, which is also the state bucket's access key id."
  value       = cloudflare_api_token.ci_deploy.id
  sensitive   = true
}

output "environment_secrets" {
  description = "The secrets written to the GitHub Environment, by name."
  value       = sort(tolist(local.environment_secret_names))
}

output "repository_secrets" {
  description = "The repository secrets written, by name."
  value       = sort(tolist(local.repository_secret_names))
}
