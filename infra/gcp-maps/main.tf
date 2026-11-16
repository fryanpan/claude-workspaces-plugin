# The browser key the doc map uses to load Google Maps. A browser key is
# public by design: it ships in page JavaScript. What limits it is the two
# restrictions below, the referrer list and the one API it may call.
#
# The provider reads the operator's gcloud application-default login
# (`gcloud auth application-default login`); no credential is in this root.

provider "google" {
  project = var.project
}

resource "google_project_service" "apis" {
  for_each = toset([
    "apikeys.googleapis.com",
    "maps-backend.googleapis.com",
  ])

  service = each.key

  # Destroying this root removes the key, not the APIs: other things in the
  # project may use them.
  disable_on_destroy = false
}

resource "google_apikeys_key" "maps_browser" {
  name         = "workspaces-maps-browser"
  display_name = var.display_name

  restrictions {
    browser_key_restrictions {
      allowed_referrers = var.allowed_referrers
    }

    api_targets {
      service = "maps-backend.googleapis.com"
    }
  }

  depends_on = [google_project_service.apis]
}

# The key, for the server on this machine. The server reads this file at boot
# (packages/server/src/google-maps-key.ts), so prod gets the key without an
# edit to its launchd plist; a restart picks up a new one.
resource "local_sensitive_file" "maps_browser_key" {
  filename             = pathexpand(var.key_file)
  content              = google_apikeys_key.maps_browser.key_string
  file_permission      = "0600"
  directory_permission = "0700"
}
