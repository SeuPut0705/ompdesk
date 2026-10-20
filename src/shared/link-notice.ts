/**
 * How long a link to the computer must stay down before any surface says so (the desktop's reconnecting
 * banner, the phone's connection bar). A drop that heals inside it shows nothing.
 *
 * 2.5 s covers the first retry of both clients plus the dial that follows it: the page's first retry is
 * 500 ms (+25 % jitter, `ws-transport.ts` `BACKOFF_FIRST_MS`) and a socket opens in a few hundred ms; the
 * desktop's first retry is 1 s (`main/remote/client.ts` `RECONNECT_MIN_MS`) plus a tailnet dial and
 * handshake. A phone page returning from the background (one routine drop, back in ~0.5 s) and an app
 * start or window reload therefore stay silent, while an outage that outlasts the first retry shows
 * within 2.5 s and stays until the link is back.
 */
export const LINK_NOTICE_GRACE_MS = 2500;
