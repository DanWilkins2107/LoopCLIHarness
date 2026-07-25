variable "region" {
  type = string
}

variable "name_prefix" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "repo_owner" {
  type = string
}

variable "repo_name" {
  type = string
}

variable "prod_environment" {
  type    = string
  default = "prod"
}
