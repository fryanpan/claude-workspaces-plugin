output "routes" {
  description = "Route key -> pattern of the share-link Worker."
  value       = { for key, r in cloudflare_workers_route.share_link : key => r.pattern }
}
