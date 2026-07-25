terraform {
  backend "s3" {
    bucket         = "loopcli-tfstate"
    dynamodb_table = "loopcli-tflock"
    key            = "root/terraform.tfstate"
    region         = "eu-west-2"
    encrypt        = true
  }
}
