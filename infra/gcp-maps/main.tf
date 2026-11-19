# The browser key the doc map uses to load Google Maps. A browser key is
# public by design: it ships in page JavaScript. What limits it is the two
# restrictions below, the referrer list and the one API it may call.
#
# The provider reads the operator's gcloud application-default login
# (`gcloud auth application-default login`); no credential is in this root.

provider "google" {
  project = var.project
}

provider "google-beta" {
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

# Bryan's spend cap (19 Nov 2026): at most $5 a day on Maps. A key cannot
# carry a dollar limit, so the cap is a daily quota on the project. The doc
# map loads the Maps JavaScript API in 2D, which Google bills per map load
# under the `billable_default` metric at $7 per 1,000 (Dynamic Maps SKU);
# 714 loads is $5.00. Past it Google refuses further loads until the quota
# resets at midnight Pacific, and the page shows its map error. 3D maps bill
# under their own metric; nothing here uses them, so their quota is 0.
locals {
  daily_quota = {
    "maps-backend.googleapis.com/billable_default"    = var.daily_map_loads
    "maps-backend.googleapis.com/3d_billable_default" = 0
  }
}

resource "google_service_usage_consumer_quota_override" "daily" {
  for_each = local.daily_quota
  provider = google-beta

  project        = var.project
  service        = "maps-backend.googleapis.com"
  metric         = urlencode(each.key)
  limit          = urlencode("/d/project")
  override_value = tostring(each.value)
  # Google refuses a cut of more than 10% below the current limit without it.
  force = true

  depends_on = [google_project_service.apis]
}
