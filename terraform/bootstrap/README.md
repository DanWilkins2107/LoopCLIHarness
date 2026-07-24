# State backend bootstrap

Run-once config that creates the remote state store — an S3 bucket (versioned,
encrypted, private) and a DynamoDB lock table. It uses **local state** on
purpose: it creates the store, so it cannot live in the store it creates.

This is not the long-running state. Its own `terraform.tfstate` stays local and
gitignored; the bucket it creates becomes the backend for the root `terraform/`
config and everything else.

## Deploying from scratch

1. `cd terraform/bootstrap`
2. `terraform init` (local backend, no config needed)
3. `terraform apply -var region=<region> -var name_prefix=<prefix>`
4. Note the `state_bucket` and `lock_table` outputs.
5. Wire the root `terraform/` backend to them — the S3 backend block is static,
   so copy the values in by hand or pass them via `-backend-config`.
6. `terraform init` the root config against the new backend.

After this, the bucket and lock table are long-lived. Both carry
`prevent_destroy` — losing them means losing all remote state.
