/** What the pairing screen (PairScreen.tsx) reads and writes, apart from React: codes, names, the API's answers. */

const CODE_LENGTH = 8;

/** The code a person typed, as the host reads it: Crockford, I/L→1, O→0, no dashes or spaces; null if not a code. */
export function normalizePairCode(input: string): string | null {
	const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
	return code.length === CODE_LENGTH && /^[0-9A-HJKMNP-TV-Z]+$/.test(code) ? code : null;
}

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

export type PairFailure = "noCode" | "declined" | "limited" | "badCode" | "network" | "key";

/** `POST /api/pair`'s refusals by status (400 malformed code, 403 declined or timed out, 404 no active code, 429 limited). */
export const PAIR_FAILURE_BY_STATUS: Record<number, PairFailure> = {
	400: "badCode",
	403: "declined",
	404: "noCode",
	429: "limited",
};
