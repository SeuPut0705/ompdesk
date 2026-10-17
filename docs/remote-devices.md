# Remote devices

[한국어](remote-devices.ko.md) · [Back to the README](../README.md)

Work with another computer's omp, files, Git and accounts from this one. The tabs run on the other computer; you see and steer them here.

![Settings › Devices & connections: sharing this computer, connecting to a device, SSH hosts and Mobile web](media/devices.webp)

## Connect two computers

1. Install OMPdesk on both. omp installs itself on each computer's first launch.
2. On the computer that **runs the work**, open **Settings › Devices & connections › OMPdesk sharing** and turn on **Let other devices use this computer**. Note the pairing code (`XXXX-XXXX`). It works once, for 10 minutes.
3. On the computer you are **sitting at**, press **Connect to a device**, pick the computer from the list (same network) or type its address, and enter the code. On networks such as Tailscale, type the address.
4. Open the other computer's projects and sessions from the sidebar.

Connections are authenticated with per-device keys and encrypted. Settings and statistics of a remote tab are that computer's.

## Good to know

- A remote tab uses that computer's omp, accounts, files, terminal and history. Its omp, extensions and tools are updated by that computer's own OMPdesk.
- This is separate from [Mobile web](mobile-web.md), which opens OMPdesk from a phone browser over Tailscale.
