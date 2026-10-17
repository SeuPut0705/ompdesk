# Mobile web (beta)

[한국어](mobile-web.ko.md) · [Back to the README](../README.md)

Use OMPdesk from a phone or tablet: steer a running task, answer a question, read the result. **Beta, off by default**; it has not had real-device checks on every phone yet.

The page is served by OMPdesk on your computer and published only to your own [Tailscale](https://tailscale.com) network. Nothing goes through a server of ours, and only devices on your tailnet can open it.

## Set it up

1. On the computer, open **Settings › Devices & connections › Mobile web** and turn on **Use OMPdesk from a phone or tablet**. OMPdesk walks you through what is missing: installing Tailscale, signing in, and (if your tailnet needs it) enabling HTTPS certificates.
2. Install Tailscale on the phone and sign in with the same account.
3. Press **Pair a phone** and scan the QR code with the phone's camera. The code works once, and you approve the phone in OMPdesk on the computer.
4. Optional: on iPhone and iPad, tap Share › Add to Home Screen to run it as an app and to get notifications.

## Notifications

In the phone's **Settings › Mobile web**, **Notifications on this device** is opt-in per device. Turn it on to hear when an agent finishes, fails or asks something while the page is closed. **Hide content** shows only what happened, without session names or text.

## Control who can do what

- **Paired devices** lists every phone and tablet. Rename one, change its access (**Full access**, **No computer control**, **Chat and view only**, or custom permissions), or **Revoke** it. A revoked device must pair again with a new code.
- **Allowed Tailscale users** are the accounts that can open the page. Each device still needs its own pairing code.
- Turning the switch off removes OMPdesk's own Tailscale handler and nothing else.
- If Tailscale Funnel exposes the port to the public internet, Mobile web refuses to start. Turn Funnel off for that port.

## Limits

The page is for steering and reading. Preview and Terminal work on a phone; opening a file or link on the computer needs the **Control this computer** permission.
