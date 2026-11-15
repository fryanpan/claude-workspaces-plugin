output "maps_browser_key" {
  description = "The browser key's string. Read it with `terraform output -raw maps_browser_key`."
  value       = google_apikeys_key.maps_browser.key_string
  sensitive   = true
}

output "maps_browser_key_name" {
  description = "The key's resource name, for the console or gcloud."
  value       = google_apikeys_key.maps_browser.name
}
