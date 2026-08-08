# `spawn` — scheduled supervisor-spawning Lambda

Stateless Lambda invoked on a cron. Each tick it reaps over-age supervisor
instances and, when none is live and the board has recommended work, launches
one from the supervisor launch template. It never runs a task itself.

## Configuration

Environment (validated with zod at module load — see `env.ts`):

| Variable | Notes |
| --- | --- |
| `AGENTJIRA_PROJECT_ID` | Board project to check for work |
| `BOARD_SECRET_ARN` | Secrets Manager secret holding the board login |
| `LAUNCH_TEMPLATE_ID` | Supervisor launch template |
| `SUBNET_ID` | Subnet to launch into |
| `MAX_INSTANCE_AGE_MINUTES` | Reaper TTL, default 720 |

The board secret is a JSON object with the same keys the `aj` CLI config uses:
`url`, `anon_key`, `email`, `password`. It is a board *user* credential with
write access to the whole board, so it lives in Secrets Manager and is read at
invoke time — never an environment literal.

## Build

```bash
npm ci
npm run build   # esbuild bundle -> dist/index.js
```

Deployed as handler `index.handler` on `nodejs22`. Packaging `dist/` and
provisioning the schedule, role and launch template is Terraform's job, not this
package's.
