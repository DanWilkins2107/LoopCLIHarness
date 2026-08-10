# Deploy

## `supervisor-loop.service`

Behaviour is documented in the unit file itself. VM boot
(`terraform/modules/vm/user-data.yaml.tftpl`) clones the repo to `/opt/loopcliharness`,
installs both npm toolchains and the `aj` CLI, copies this unit into
`/etc/systemd/system/`, then enables and starts it — the box begins working as soon as it
boots.

`aj` has no credentials on the box yet, so the loop aborts and exits 0. The unit powers off
on any exit, and the launch template terminates on guest poweroff with the root volume
deleted — so an unusable box tears itself down rather than idling.
