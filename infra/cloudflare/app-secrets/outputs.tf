# Names only: no value leaves this root as an output.

output "environment_secrets" {
  description = "The secrets written to the GitHub Environment, by name."
  value       = sort(tolist(local.secret_names))
}
