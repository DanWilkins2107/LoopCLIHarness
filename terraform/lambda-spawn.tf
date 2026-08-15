resource "aws_secretsmanager_secret" "board_credentials" {
  name        = "${local.name_prefix}-board-credentials"
  description = "AgentJira board login for the spawn Lambda; the value is filled in by hand, never by Terraform."
}

output "board_secret_arn" {
  value = aws_secretsmanager_secret.board_credentials.arn
}
