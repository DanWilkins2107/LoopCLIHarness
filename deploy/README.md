# Deploy

## `supervisor-loop.service`

systemd **oneshot** unit that runs the supervisor loop (`../supervisor/loop.ts`) on
boot and turns its idle exit into an actual instance stop.

- **Clean exit 0** (idle: `IDLE_SHUTDOWN_S` with nothing in progress) → `ExecStopPost`
  runs `systemctl poweroff` → ordered shutdown → the instance stops itself.
- **Non-zero exit** (fatal) → poweroff is skipped → unit `failed`, box stays up as an
  inspection window (`journalctl -u supervisor-loop`).

### Install (on the VM)

The unit assumes the repo checked out at `/opt/loopcliharness` with the supervisor's
toolchain installed:

```sh
cd /opt/loopcliharness/supervisor && npm install   # pulls tsx/typescript
cp /opt/loopcliharness/deploy/supervisor-loop.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable supervisor-loop.service            # run on boot
```

`aj`, `claude`, and Node.js (>=18) must be on the system `PATH`; `npm start` puts the
supervisor's local `node_modules/.bin` (tsx) on `PATH` for the loop and its child runners.
Provisioning the box, the install path, and the toolchain is owned by the VM/boot infra
node (AgentJira `8276b707`).

### Cross-node contract

Poweroff stops rather than terminates the instance **only** because the VM's Terraform
sets `InstanceInitiatedShutdownBehavior = stop` (owned by `8276b707`, not set here). With
that, a clean stop is a normal user-initiated transition: no terminate, root volume
preserved, no failed status check (checks apply to running instances only), nothing pages.
