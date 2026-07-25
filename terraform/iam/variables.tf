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
  type        = string
  description = "GitHub org/user that owns the repo. Scopes the OIDC trust sub. Change only when the repo moves owners."
}

variable "repo_name" {
  type        = string
  description = "GitHub repo name. Scopes the OIDC trust sub. Change only when the repo is renamed/moved."
}

variable "prod_environment" {
  type    = string
  default = "prod"
}
