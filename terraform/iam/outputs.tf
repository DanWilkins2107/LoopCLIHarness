output "oidc_provider_arn" {
  value = aws_iam_openid_connect_provider.github.arn
}

output "ci_plan_role_arn" {
  value = aws_iam_role.ci_plan.arn
}

output "ci_apply_role_arn" {
  value = aws_iam_role.ci_apply.arn
}
