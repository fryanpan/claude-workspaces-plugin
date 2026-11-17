# The sign-in test app's root against a mock provider: no token, no account,
# no state. Run by `bun run check:cloudflare-tf`.

mock_provider "cloudflare" {
  mock_data "cloudflare_zone" {
    defaults = {
      id = "0123456789abcdef0123456789abcdef"
    }
  }
}

variables {
  account_id  = "fedcba9876543210fedcba9876543210"
  app_name    = "riverbend-signin"
  zone_name   = "harborlight.test"
  hostname    = "signin.harborlight.test"
  mail_domain = "mail.harborlight.test"
  mail_records = [
    { key = "dkim-txt", type = "TXT", name = "resend._domainkey.mail.harborlight.test", content = "p=fixture" },
    { key = "spf-mx", type = "MX", name = "send.mail.harborlight.test", content = "feedback-smtp.example.test", priority = 10 },
    { key = "spf-txt", type = "TXT", name = "send.mail.harborlight.test", content = "v=spf1 include:example.test ~all" },
  ]
}

run "the_app_gets_its_database_widget_domain_and_mail_records" {
  command = plan

  assert {
    condition     = cloudflare_d1_database.app.name == "riverbend-signin"
    error_message = "the database is named for the app"
  }

  assert {
    condition     = tolist(cloudflare_turnstile_widget.app.domains) == tolist(["signin.harborlight.test"])
    error_message = "the widget answers for the app's hostname alone"
  }

  assert {
    condition = (
      cloudflare_workers_custom_domain.app.hostname == "signin.harborlight.test" &&
      cloudflare_workers_custom_domain.app.service == "riverbend-signin" &&
      cloudflare_workers_custom_domain.app.zone_id == "0123456789abcdef0123456789abcdef"
    )
    error_message = "the hostname is the Worker's custom domain, in the zone read back"
  }

  assert {
    condition     = toset(keys(cloudflare_dns_record.mail)) == toset(["dkim-txt", "spf-mx", "spf-txt"])
    error_message = "one record per Resend record, keyed by label, never by hostname"
  }

  assert {
    condition = (
      cloudflare_dns_record.mail["spf-mx"].priority == 10 &&
      cloudflare_dns_record.mail["spf-txt"].priority == null &&
      alltrue([for r in cloudflare_dns_record.mail : r.proxied == false])
    )
    error_message = "the MX keeps its priority, nothing else has one, and no mail record is proxied"
  }
}

run "a_record_for_the_zone_itself_is_refused" {
  command = plan

  variables {
    mail_records = [
      { key = "root-mx", type = "MX", name = "harborlight.test", content = "feedback-smtp.example.test", priority = 10 },
    ]
  }

  expect_failures = [var.mail_records]
}

run "a_record_beside_the_mail_domain_is_refused" {
  command = plan

  variables {
    mail_records = [
      { key = "dmarc", type = "TXT", name = "_dmarc.harborlight.test", content = "v=DMARC1; p=none" },
    ]
  }

  expect_failures = [var.mail_records]
}

run "the_zone_itself_is_not_a_mail_domain" {
  command = plan

  variables {
    mail_domain  = "harborlight.test"
    mail_records = []
  }

  expect_failures = [var.mail_domain]
}

run "an_a_record_is_not_a_mail_record" {
  command = plan

  variables {
    mail_records = [
      { key = "a", type = "A", name = "mail.harborlight.test", content = "192.0.2.1" },
    ]
  }

  expect_failures = [var.mail_records]
}
