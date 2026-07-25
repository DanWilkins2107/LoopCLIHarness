# CI OIDC + IAM roles

GitHub Actions OIDC identity provider and the two least-privilege roles CI
assumes to reach AWS with **no long-lived secrets**. Consumed by the Terraform
CI workflow (plan-on-PR, apply-on-merge).

- `${name_prefix}-ci-plan` — assumable from this repo's pull requests and the
  `main` branch. Read-only on EC2 plus read/write on the remote state backend.
- `${name_prefix}-ci-apply` — assumable only from the gated `prod` GitHub
  Environment. Adds mutating EC2 actions on top of the plan role's grants.

Trust is scoped to exact `sub` strings (no wildcards) for `repo_owner/repo_name`;
`aud` is `sts.amazonaws.com`.

## Local state, admin apply from main

Like `terraform/bootstrap`, this config uses **local state** and is applied by an
admin from `main`: the CI roles must exist before CI can assume them, so this
cannot be applied by CI. Keeping it out of the root `terraform/` config also
avoids the root CI role having to self-manage IAM.

1. `cd terraform/iam`
2. `terraform init` (local backend, no config needed)
3. `terraform apply -var region=<region> -var name_prefix=<prefix> \
     -var repo_owner=<owner> -var repo_name=<repo>`
4. Wire the `ci_plan_role_arn` / `ci_apply_role_arn` outputs into the CI workflow.

The `prod` GitHub Environment must exist (and gate the apply job) for the apply
role's trust to match; override its name with `-var prod_environment=<name>`.
