variable "region" {
  type = string
}

variable "name_prefix" {
  type = string
}

variable "tags" {
  type = map(string)
}

variable "account_id" {
  type        = string
  description = "AWS account the CI roles live in. Builds the exact state-lock ARN for least-priv."
}

variable "repo_owner" {
  type        = string
  description = "GitHub org/user that owns the repo. Scopes the OIDC trust sub. Change only when the repo moves owners."
}

variable "repo_name" {
  type        = string
  description = "GitHub repo name. Scopes the OIDC trust sub. Change only when the repo is renamed/moved."
}
