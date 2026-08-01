output "vm_launch_template_id" {
  value = module.vm.launch_template_id
}

output "vm_launch_template_latest_version" {
  value = module.vm.launch_template_latest_version
}

output "vm_security_group_id" {
  value = module.vm.security_group_id
}

output "vm_subnet_id" {
  value = module.network.subnet_id
}

output "vm_instance_role_name" {
  value = module.vm.instance_role_name
}

output "vm_instance_role_arn" {
  value = module.vm.instance_role_arn
}
