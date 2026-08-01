output "launch_template_id" {
  value = aws_launch_template.vm.id
}

output "launch_template_latest_version" {
  value = aws_launch_template.vm.latest_version
}

output "security_group_id" {
  value = aws_security_group.vm.id
}

output "subnet_id" {
  value = aws_subnet.public.id
}

output "instance_role_name" {
  value = aws_iam_role.vm.name
}

output "instance_role_arn" {
  value = aws_iam_role.vm.arn
}
