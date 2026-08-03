data "tls_certificate" "github" {
  url = "https://token.actions.githubusercontent.com/.well-known/openid-configuration"
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github.certificates[0].sha1_fingerprint]
}

data "aws_iam_policy_document" "ci_plan_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.repo_owner}/${var.repo_name}:pull_request",
        "repo:${var.repo_owner}/${var.repo_name}:ref:refs/heads/main",
      ]
    }
  }
}

data "aws_iam_policy_document" "ci_apply_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.repo_owner}/${var.repo_name}:environment:deploy"]
    }
  }
}

# State backend lives in terraform/bootstrap: bucket ${name_prefix}-tfstate,
# lock table ${name_prefix}-tflock. Rename there -> rename here.
data "aws_iam_policy_document" "state_access" {
  statement {
    sid       = "StateBucketList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.name_prefix}-tfstate"]
  }

  statement {
    sid       = "StateObjectRW"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.name_prefix}-tfstate/root/*"]
  }

  statement {
    sid       = "StateLock"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = ["arn:aws:dynamodb:${var.region}:${var.account_id}:table/${var.name_prefix}-tflock"]
  }
}

data "aws_iam_policy_document" "ci_plan" {
  source_policy_documents = [data.aws_iam_policy_document.state_access.json]

  statement {
    sid       = "Ec2Read"
    effect    = "Allow"
    actions   = ["ec2:Describe*", "ec2:Get*"]
    resources = ["*"]
  }
}

data "aws_iam_policy_document" "ci_apply" {
  source_policy_documents = [data.aws_iam_policy_document.state_access.json]

  statement {
    sid       = "Ec2Read"
    effect    = "Allow"
    actions   = ["ec2:Describe*", "ec2:Get*"]
    resources = ["*"]
  }

  statement {
    sid    = "Ec2Compute"
    effect = "Allow"
    actions = [
      "ec2:RunInstances",
      "ec2:TerminateInstances",
      "ec2:StartInstances",
      "ec2:StopInstances",
      "ec2:RebootInstances",
      "ec2:ModifyInstanceAttribute",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "Ec2Tagging"
    effect    = "Allow"
    actions   = ["ec2:CreateTags", "ec2:DeleteTags"]
    resources = ["*"]
  }

  statement {
    sid    = "Ec2Keys"
    effect = "Allow"
    actions = [
      "ec2:CreateKeyPair",
      "ec2:ImportKeyPair",
      "ec2:DeleteKeyPair",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role" "ci_plan" {
  name               = "${var.name_prefix}-ci-plan"
  assume_role_policy = data.aws_iam_policy_document.ci_plan_assume.json
}

resource "aws_iam_role_policy" "ci_plan" {
  name   = "${var.name_prefix}-ci-plan"
  role   = aws_iam_role.ci_plan.id
  policy = data.aws_iam_policy_document.ci_plan.json
}

resource "aws_iam_role" "ci_apply" {
  name               = "${var.name_prefix}-ci-apply"
  assume_role_policy = data.aws_iam_policy_document.ci_apply_assume.json
}

resource "aws_iam_role_policy" "ci_apply" {
  name   = "${var.name_prefix}-ci-apply"
  role   = aws_iam_role.ci_apply.id
  policy = data.aws_iam_policy_document.ci_apply.json
}
