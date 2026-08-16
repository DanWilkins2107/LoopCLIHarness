resource "aws_secretsmanager_secret" "board_credentials" {
  name        = "${local.name_prefix}-board-credentials"
  description = "AgentJira board login for the spawn Lambda; the value is filled in by hand, never by Terraform."
}

output "board_secret_arn" {
  value = aws_secretsmanager_secret.board_credentials.arn
}

# dist/ is gitignored: run `npm run build -w @loopcliharness/lambda-spawn`
# before plan or apply, or this data source fails.
data "archive_file" "spawn" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/spawn/dist"
  output_path = "${path.module}/build/lambda-spawn.zip"
}

data "aws_iam_policy_document" "spawn_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "spawn" {
  name               = "${local.name_prefix}-spawn"
  assume_role_policy = data.aws_iam_policy_document.spawn_assume.json
}

resource "aws_iam_role_policy_attachment" "spawn_basic_execution" {
  role       = aws_iam_role.spawn.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "spawn" {
  statement {
    sid       = "SecretRead"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.board_credentials.arn]
  }
}

resource "aws_iam_role_policy" "spawn" {
  name   = "${local.name_prefix}-spawn"
  role   = aws_iam_role.spawn.name
  policy = data.aws_iam_policy_document.spawn.json
}

resource "aws_lambda_function" "spawn" {
  function_name = "${local.name_prefix}-spawn"
  role          = aws_iam_role.spawn.arn
  runtime       = "nodejs22.x"
  handler       = "index.handler"

  filename         = data.archive_file.spawn.output_path
  source_code_hash = data.archive_file.spawn.output_base64sha256

  # The default 3s cannot cover a board read plus three EC2 calls.
  timeout = 60

  # One in flight at a time, so two ticks cannot both decide to spawn.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      AGENTJIRA_PROJECT_ID = "13a42f3e-a4bb-4274-aadd-85feef6e74af"
      BOARD_SECRET_ARN     = aws_secretsmanager_secret.board_credentials.arn
      LAUNCH_TEMPLATE_ID   = module.vm.launch_template_id
      SUBNET_ID            = module.network.subnet_id
    }
  }
}
