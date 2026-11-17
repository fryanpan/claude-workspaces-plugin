# What deploy.ts reads to write the Worker's wrangler config and secrets.

output "script_name" {
  description = "The Worker's name."
  value       = cloudflare_workers_script.app.script_name
}

output "d1_database_id" {
  description = "The D1 database's id, for the wrangler config's binding."
  value       = cloudflare_d1_database.app.id
}

output "turnstile_sitekey" {
  description = "The Turnstile widget's public site key."
  value       = cloudflare_turnstile_widget.app.sitekey
}

output "turnstile_secret" {
  description = "The widget's secret, which deploy.ts sets as the Worker's TURNSTILE_SECRET_KEY."
  value       = cloudflare_turnstile_widget.app.secret
  sensitive   = true
}
