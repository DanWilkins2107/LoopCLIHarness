output "vpc_id" {
  value = aws_vpc.this.id
}

output "subnet_id" {
  value = aws_subnet.private.id
}

output "dns_resolver_cidr" {
  value = "${cidrhost(local.vpc_cidr, 2)}/32"
}
