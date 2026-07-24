# Root Terraform module

Shared conventions (version pins, AWS provider, tagging, input variables) and the
VM module skeleton. No compute yet.

## Backend init

The S3 backend block is static (`key`, `encrypt`). Bucket and lock table come from
the bootstrap outputs at init time, not rederived names:

```sh
terraform init \
  -backend-config="bucket=$(terraform -chdir=../bootstrap output -raw state_bucket)" \
  -backend-config="dynamodb_table=$(terraform -chdir=../bootstrap output -raw lock_table)" \
  -backend-config="region=<region>"
```

AWS auth comes from the environment / `AWS_PROFILE` at apply time — no creds in files.
