# The same R2 bucket as prod, under its own key (`cloudflare/signin-test.tfstate`).
# `infra/signin-test/deploy.ts` passes the bucket, key and endpoint at init,
# and the R2 credentials arrive as AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
# from `ci-credentials.ts`. The skip_* flags turn off the checks only AWS
# answers.
terraform {
  backend "s3" {
    region                      = "auto"
    use_path_style              = true
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}
