# Security Policy

## Supported versions

Only the latest release of OMPdesk gets security fixes. Please update before you report.

## Reporting a vulnerability

Report privately through GitHub Security Advisories. Do not open a public issue for a vulnerability.

1. Open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to <https://github.com/SeuPut0705/ompdesk/security/advisories/new>.
2. Include:
   - the OMPdesk version, your OS, and the output of `omp --version`;
   - what an attacker can do and what they need first (local access, a paired device, network position);
   - steps to reproduce, or a proof of concept;
   - any logs or screenshots, with secrets removed.

OMPdesk is maintained by one person. I read reports on a best-effort basis and will try to answer within a few days. I cannot promise a fix date. I will credit you in the release notes if you want.

## Scope

In scope:

- **Mobile web server.** It listens on `127.0.0.1:47831` only. Reaching it from a phone goes through `tailscale serve`, so exposure depends on your Tailscale setup. Each device pairs once with a code, and requests are checked for host, origin and device credentials.
- **Remote devices.** Pairing between two OMPdesk installs uses a short-lived single-use code and a key exchange. Later connections are authenticated and encrypted per device.
- **Updater.** It reads GitHub releases and checks the SHA-512 of the downloaded file against the release metadata before installing.
- **App code that handles files, paths, links and untrusted model output.**

Out of scope:

- Vulnerabilities in omp itself. Report those to [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). OMPdesk is an unofficial app and does not bundle or modify omp.
- Attacks that need an already compromised computer or account.
- Anything the agent does when you approve it or when your own omp settings allow it.

## Signing

Release builds are signed with OMPdesk's own self-signed certificate. The macOS build is **not notarized by Apple**, which is why Gatekeeper asks you to right-click > Open on first launch. Windows may show a SmartScreen warning for the same reason. Check that you downloaded the file from this repository's [Releases](https://github.com/SeuPut0705/ompdesk/releases) page.
