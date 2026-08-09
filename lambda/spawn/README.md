# `spawn` — scheduled supervisor-spawning Lambda

Stateless Lambda invoked on a cron. Each tick it reaps over-age supervisor
instances and, when none is live and the board has recommended work, launches
one from the supervisor launch template. It never runs a task itself.

Read `handler.ts` for the whole tick. Top-level modules are the flow and the
rules worth reviewing (`handler` → `decide` / `board` → `recommended`);
`helpers/` is the EC2, Secrets Manager and Supabase plumbing they call.

## Configuration

Environment (validated with zod at module load — see `env.ts`):

| Variable | Notes |
| --- | --- |
| `AGENTJIRA_PROJECT_ID` | Board project to check for work |
| `BOARD_SECRET_ARN` | Secrets Manager secret holding the board login |
| `LAUNCH_TEMPLATE_ID` | Supervisor launch template |
| `SUBNET_ID` | Subnet to launch into |

The reaper TTL is hardcoded in `constants.ts`, not configurable.

The board secret is a JSON object with the same keys the `aj` CLI config uses:
`url`, `anon_key`, `email`, `password`. It is a board *user* credential with
write access to the whole board, so it lives in Secrets Manager and is read at
invoke time — never an environment literal.

## Build

From the repo root (this is an npm workspace):

```bash
npm ci
npm run build -w lambda/spawn   # esbuild bundle -> dist/index.js
```

Deployed as handler `index.handler` on `nodejs22`. Packaging `dist/` and
provisioning the schedule, role and launch template is Terraform's job, not this
package's.
