/**
 * How long a link to the computer must stay down before any surface says so (the title bar's status turning to
 * "Reconnecting…", on a phone's page and for a desktop tab of a paired host). A drop that heals inside it shows
 * nothing.
 *
 * 3 s, from `e2e/phone-reconnect.e2e.ts` (2 Nov 2026): the page retries at once, then after 0.25, 0.5 and 1 s and every
 * second after (`ws-transport.ts` `RETRY_MS`), so a network that is gone for 2 s is back on the socket by about 2.5 s
 * (measured 2.54 s from the cut, a message sent meanwhile); a blip is back in 12-130 ms, a short outage 0.1-0.2 s after
 * the network. The desktop's first retry is 1 s (`main/remote/client.ts` `RECONNECT_MIN_MS`) plus a tailnet dial and
 * handshake. A phone page returning from the background and an app start or window reload therefore stay silent,
 * while an outage that outlasts a couple of retries shows within 3 s and stays until the link is back.
 */
export const LINK_NOTICE_GRACE_MS = 3000;
