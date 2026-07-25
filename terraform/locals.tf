locals {
  region      = "eu-west-2"
  name_prefix = "loopcli"

  common_tags = {
    Project   = local.name_prefix
    ManagedBy = "terraform"
  }
}
