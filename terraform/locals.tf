locals {
  region      = "eu-west-2"
  name_prefix = "loopcliharness"

  # Harness revision the VM checks out at boot. Bump to ship harness changes;
  # the launch template's user_data changes with it.
  repo_ref = "440e5025c8cbc57c00d101427ec74a494a525830"

  common_tags = {
    Project   = local.name_prefix
    ManagedBy = "terraform"
  }
}
