variable "name" {
  type = string
}

variable "subnet_id" {
  type = string
}

variable "ssh_public_key" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
