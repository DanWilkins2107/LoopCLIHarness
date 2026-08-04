variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "dns_resolver_cidr" {
  type = string
}

variable "repo_ref" {
  type        = string
  description = "Harness commit SHA or tag checked out into /opt/loopcliharness at boot"
}

variable "instance_type" {
  type    = string
  default = "t3.medium"
}

variable "root_volume_size" {
  type    = number
  default = 30
}
