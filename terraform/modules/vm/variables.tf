variable "name" {
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
