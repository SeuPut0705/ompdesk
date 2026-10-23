# Mobile web (beta)

[한국어](mobile-web.ko.md) · [Back to the README](../README.md)

Use OMPdesk from a phone or tablet: steer a running task, answer a question, read the result. **Beta, off by default**; it has not had real-device checks on every phone yet.

The page is served by OMPdesk on your computer and published only to your own [Tailscale](https://tailscale.com) network. Nothing goes through a server of ours, and only devices on your tailnet can open it. **There is no pairing code:** a device signed in to your Tailscale account opens the link and is connected.

## Set it up

1. On the computer, open **Settings › Devices & connections › Mobile web** and turn on **Use OMPdesk from a phone or tablet**. OMPdesk walks you through what is missing: installing Tailscale, signing in, and (if your tailnet needs it) enabling HTTPS certificates.
2. Install Tailscale on the phone and sign in with the same account.
3. Press **Copy link** (or scan the QR code next to it) and open the link on the phone. The first visit connects the phone; you do not enter a code or approve anything.
4. Optional: on iPhone and iPad, tap Share › Add to Home Screen to run it as an app and to get notifications.

When a new device connects, OMPdesk shows one quiet notice on the computer (for example "New device connected: SeuPut S25U") with a **Block** button. If you want to say yes first, turn on **Approve new devices on this computer** (off by default): a new device then waits for your OK in a dialog on the computer before it connects.

Your other computers come along: the computers this one is connected to (Settings › Devices & connections) are listed on the phone too, and you can open their sessions through this computer. When such a computer has Mobile web on as well, its header in the phone's sidebar has a button that opens that computer's own page directly; the phone connects there the same way, by its Tailscale account.

A device that opens the link while signed in to a *different* Tailscale account sees a page that says so and names the accounts that may open it.

## Notifications

In the phone's **Settings › Devices & connections › Mobile web**, **Notifications on this device** is opt-in per device. Turn it on to hear when an agent finishes, fails or asks something while the page is closed. **Hide content** shows only what happened, without session names or text.

## Control who can do what

- **Connected devices** lists every phone and tablet, named after its Tailscale device name. Rename one, change its access (**Full access**, **No computer control**, **Chat and view only**, or custom permissions), or **Block** it.
- **Block** keeps a device out for good, not only until its next visit: the block is kept for that device's Tailscale node, so your other devices keep working. It sees a "This device is blocked" page and cannot connect again. If Tailscale does not say which device it is, OMPdesk blocks every device signed in to that account instead, and the confirm says so. Blocked devices are listed under **Blocked**, where **Unblock** lets a device connect again on its next visit.
- **Allowed Tailscale users** are the accounts whose devices can connect, without a code. This computer's own account is allowed by default.
- Turning the switch off removes OMPdesk's own Tailscale handler and nothing else.
- If Tailscale Funnel exposes the port to the public internet, Mobile web refuses to start. Turn Funnel off for that port.

## How it is secured

Your Tailscale account is the identity. `tailscale serve` tells OMPdesk which account a request comes from (the `Tailscale-User-Login` header), and OMPdesk believes it only when:

- the request came through `tailscale serve`: OMPdesk publishes a per-install secret path (`serve --bg --https=<port> http://127.0.0.1:<local>/<secret>`), the page itself never sees it, and a request without it gets a 404 and no header on it is read; a program on your computer that writes the same headers straight to OMPdesk's local port gets nothing;
- it is for the published address (Host, Origin and fetch-site checks), comes from this computer's loopback, and is not a Tailscale Funnel (public internet) request, which is always refused;
- the account is one of the allowed ones.

The device then gets its own cookie and key, and later visits use those. Limits: the secret sits in `web-serve-secret.json` (mode 0600) and in the serve config, so a program running as you could read it, but such a program can already read OMPdesk's cookie store and your files. Anyone you share the Tailscale device with, or any user of an allowed account, can connect a device. Allow only accounts you trust, and use **Approve new devices on this computer** if you want to see each one first.

## Limits

The page is for steering and reading. Preview and Terminal work on a phone; opening a file or link on the computer needs the **Control this computer** permission.
