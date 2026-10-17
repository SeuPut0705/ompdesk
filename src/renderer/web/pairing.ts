/** What the connect screen (PairScreen.tsx) reads, apart from React: the device's default name and the API's answers. */

/** A readable default name: "iPhone · Safari". `touchPoints` tells an iPad that reports a Mac user agent. */
export function defaultDeviceName(userAgent: string, touchPoints = 0): string {
	let device = "Browser";
	if (/iPhone/.test(userAgent)) device = "iPhone";
	else if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1)) device = "iPad";
	else if (/Android/.test(userAgent)) device = /Mobile/.test(userAgent) ? "Android phone" : "Android tablet";
	let browser = "";
	if (/EdgA?\//.test(userAgent)) browser = "Edge";
	else if (/Firefox|FxiOS/.test(userAgent)) browser = "Firefox";
	else if (/Chrome|CriOS/.test(userAgent)) browser = "Chrome";
	else if (/Safari/.test(userAgent)) browser = "Safari";
	return browser ? `${device} · ${browser}` : device;
}

export type PairFailure = "declined" | "limited" | "blocked" | "notAllowed" | "network" | "key";

/**
 * Why `POST /api/pair` refused: 429 is the rate limit; a 403 says which wall in its `{error}` — the computer
 * blocked this device, this Tailscale account may not open the page (or Tailscale gave none), or the user declined
 * (or did not answer) the approval; anything else is a failure to reach the computer.
 */
export function pairFailureOf(status: number, error: string | null): PairFailure {
	if (status === 429) return "limited";
	if (status !== 403) return "network";
	switch (error) {
		case "blocked":
			return "blocked";
		case "tailscale_user_not_allowed":
		case "no_tailscale_user":
		case "identity_mismatch":
			return "notAllowed";
		case "declined":
		case "timeout":
			return "declined";
		default:
			return "network";
	}
}
