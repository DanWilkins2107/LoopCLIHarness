terraform {
  backend "s3" {
    key     = "root/terraform.tfstate"
    encrypt = true
  }
}
