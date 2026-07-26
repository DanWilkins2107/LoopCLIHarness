# Deploy

## `supervisor-loop.service`

Install steps for the systemd unit (behaviour is documented in the unit file itself).
Assumes the repo checked out at `/opt/loopcliharness` with the supervisor toolchain
installed:

```sh
cd /opt/loopcliharness/supervisor && npm install   # pulls tsx/typescript
cp /opt/loopcliharness/deploy/supervisor-loop.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable supervisor-loop.service            # run on boot
```

`aj`, `claude`, and Node.js (>=18) must be on the system `PATH`. Provisioning the box,
the install path, and the toolchain is owned by the VM/boot infra node (AgentJira
`8276b707`).
