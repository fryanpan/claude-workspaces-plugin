# State lives in a private R2 bucket, shared by CI and the Mac. Only the
# settings that are the same everywhere are here. The bucket, the key (one per
# deployment) and the account's endpoint come from the -backend-config file
# the wrapper writes; the R2 credentials from AWS_ACCESS_KEY_ID /
# AWS_SECRET_ACCESS_KEY in the environment. The skip_* flags turn off the
# checks only AWS answers.
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
