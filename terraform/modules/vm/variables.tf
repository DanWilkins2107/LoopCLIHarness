variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "dns_resolver_cidr" {
  type = string
}

variable "instance_type" {
  type    = string
  default = "t3.medium"
}

variable "root_volume_size" {
  type    = number
  default = 30
}
