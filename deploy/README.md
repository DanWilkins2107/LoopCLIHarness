# Deploy

## `supervisor-loop.service`

Behaviour is documented in the unit file itself. VM boot
(`terraform/modules/vm/user-data.yaml.tftpl`) clones the repo to `/opt/loopcliharness`,
installs both npm toolchains, and copies this unit into `/etc/systemd/system/` — it
stops short of enabling it, so the box provisions without running work:

```sh
systemctl enable supervisor-loop.service            # run on boot
```

Enabling is owned by AgentJira `600ec9e2`. `aj` is not installed by boot yet (auth
nodes `02ee3d7b` / `71dc00bb` / `95041f51`), so the loop cannot run until those land.
