output "projects" {
  description = "Project label -> its application's audience and hostnames."
  value = {
    for label, app in cloudflare_zero_trust_access_application.project : label => {
      aud   = app.aud
      hosts = var.projects[label].hosts
    }
  }
}
