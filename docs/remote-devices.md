# Remote devices

[한국어](remote-devices.ko.md) · [Back to the README](../README.md)

Work with another computer's omp, files, Git and accounts from this one. The tabs run on the other computer; you see and steer them here.

![Settings › Devices & connections: sharing this computer, connecting to a device, SSH hosts and Mobile web](media/devices.webp)

## Connect two computers

Computers share over [Tailscale](https://tailscale.com) only. There is no pairing code: Tailscale tells each computer who connects.

1. Install OMPdesk on both, and sign both in to Tailscale (the same account, or an account the other computer allows). Settings › Devices & connections offers to install or open Tailscale when it is missing or stopped.
2. On the computer that **runs the work**, open **Settings › Devices & connections › OMPdesk sharing** and turn on **Let other devices use this computer**.
3. On the computer you are **sitting at**, the same page lists the **Computers on your tailnet**. Press **Connect** next to the one that shares OMPdesk.
4. Open the other computer's projects and sessions from the sidebar. Each computer has its own section there; a connected computer's header wears a color of its own, and its gear picks another color or none. A tab running there carries the same color on its device chip in the title bar.

The computer that shares itself listens on its Tailscale addresses only, never on your local network. Connections are encrypted end to end and pinned to each computer's key the first time they connect.

## Who may connect

- **Allowed Tailscale accounts**: by default only this computer's own account. Add others under the sharing switch; the list is the same one Mobile web uses.
- **Approve new devices on this computer**: off by default. On, a computer connecting for the first time waits until you approve it.
- **Remove** forgets a computer; it can connect again while its account is allowed. **Block** keeps its Tailscale device out (of Mobile web too) until you unblock it.
- Each connected computer's row names the OMPdesk version it runs and whether it is older or newer than this computer's, so the one to update is easy to spot. Two versions keep working together while their connection protocol is the same; when it is not, connecting says the version is incompatible, and updating both fixes it.
- If another program holds OMPdesk's port, sharing takes the next one (up to four more). When all are taken, Settings says which ports and sharing waits until one is free.

## Good to know

- A remote tab uses that computer's omp, accounts, files, terminal and history. Its omp, extensions and tools are updated by that computer's own OMPdesk.
- If a device disconnects, its tabs keep running for 10 minutes, waiting for it to come back.
- With **Continue interrupted work after relaunch** on (the default), quitting or updating OMPdesk on the computer you sit at leaves its remote tabs running on the other computer, and they come back on the next launch. With it off, quitting asks first and then stops them.
- The computer that runs the work shows those sessions in its own sidebar too, and you can type in them there; a question is answered by whichever side answers first.
- A session the other computer is working on shows it in your sidebar (the moving light and the working circle, or the waiting colour for a question) even before you open it.
- An Autopilot run in the other computer's folder belongs to that computer: it keeps running when you close it here, and its replies count against this device's daily limit until it ends.
- **Limits** on a device's row caps how much of this computer's models it may use a day, in requests and tokens.
- Memory is shared: rules, decisions and each turn's conclusion saved on one computer are recalled on the other, while memory is on at both.
- The computer that runs the work stays awake while a device is connected or its session runs. **Keep this computer awake while a device is using it** (on by default) turns that off.
- Computers paired with a code by an older OMPdesk stay connected when they are found on your tailnet; Settings names the others once, and you connect them again from the list.
- This is separate from [Mobile web](mobile-web.md), which opens OMPdesk from a phone browser over Tailscale.
