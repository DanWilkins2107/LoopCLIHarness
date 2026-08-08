data "aws_caller_identity" "current" {}

resource "aws_sns_topic" "spend_alerts" {
  provider = aws.us_east_1
  name     = "${local.name_prefix}-spend-alerts"
}

data "aws_iam_policy_document" "spend_alerts" {
  statement {
    effect    = "Allow"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.spend_alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "spend_alerts" {
  provider = aws.us_east_1
  arn      = aws_sns_topic.spend_alerts.arn
  policy   = data.aws_iam_policy_document.spend_alerts.json
}

resource "aws_sns_topic_subscription" "spend_alerts_email" {
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.spend_alerts.arn
  protocol  = "email"
  endpoint  = "danwilkins2003@gmail.com"
}

resource "aws_budgets_budget" "monthly" {
  name         = "${local.name_prefix}-monthly"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = "30"
  limit_unit   = "USD"

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.spend_alerts.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.spend_alerts.arn]
  }
}

output "spend_alert_topic_arn" {
  value = aws_sns_topic.spend_alerts.arn
}
