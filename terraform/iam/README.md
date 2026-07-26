# CI OIDC + IAM roles

GitHub Actions OIDC provider + the CI roles. See `main.tf` / `variables.tf`.

## Local state, admin apply from main

Local state (like `terraform/bootstrap`), applied by an admin from `main` — the
CI roles must exist before CI can assume them, so CI cannot apply this. Kept out
of the root `terraform/` config so the root CI role need not self-manage IAM.

    cd terraform/iam
    terraform init
    terraform apply   # vars in variables.tf

Wire the role-ARN outputs into the CI workflow's plan/apply jobs.
