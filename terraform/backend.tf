terraform {
  # Backend HCL is parsed pre-eval, so it can't reference local.name_prefix.
  # These literals must stay in sync with name_prefix in locals.tf ("loopcliharness").
  backend "s3" {
    bucket         = "loopcliharness-tfstate"
    dynamodb_table = "loopcliharness-tflock"
    key            = "root/terraform.tfstate"
    region         = "eu-west-2"
    encrypt        = true
  }
}
