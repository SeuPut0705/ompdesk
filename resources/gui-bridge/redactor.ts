/**
 * Redacts what a copied diagnostics report or a saved diagnostic bundle must not carry (Settings › Updates &
 * about › Copy diagnostics, `diagnostics.ts`; every member of the bundle zip, `local/session-dump.ts`), and the
 * conclusion of a turn memory keeps (`memory-prompt.ts` `conclusionExcerpt`). Pure text in, text out; nothing is
 * read or sent. Import-free and free of names the generated omp memory extension declares: the ai-memory build
 * embeds this file into it (`native/memory` `install_hooks.rs`, `include_str!`).
 *
 * Rule groups, applied in this order (`redactSecretText` is group 1 alone, for text that only must not carry a secret):
 *  1. credentials: URL userinfo, PEM blocks, JWTs, vendor tokens (`gh*_`, `github_pat_`, `sk-`, `xox*-`,
 *     `AKIA…`, `AIza…`), `Bearer` values, `key=value` pairs whose key names a secret, long hex
 *     runs, long mixed-case base64-ish runs;
 *  2. email addresses (`git@host` stays: it is the ssh user, not a person);
 *  3. tailnet addresses (100.64.0.0/10, `fd7a:115c:a1e0::/48` via the ULA rule, `*.ts.net`);
 *  4. LAN addresses (10/8, 172.16/12, 192.168/16, IPv6 `fe80::` and `fc00::/7`);
 *  5. home directories (`/Users/<name>`, `C:\Users\<name>`, `/home/<name>`) → `~`.
 *
 * Deliberately kept: version numbers (semver, four-part builds such as `10.0.22631.4890`,
 * Chrome's `136.0.7103.113`), UUIDs, short commit hashes, loopback and public addresses,
 * ordinary words and identifiers. A false negative leaks, a false positive only blanks a
 * word, so a rule leans towards redacting; the tests pin both sides.
 */

const REDACTED_SECRET = "<secret>";
const REDACTED_TOKEN = "<token>";

/** `//user:pass@host`: the password and the user both go. */
const URL_USERINFO = /(\/\/)[^\s/:@]+:[^\s/@]+@/g;
/** A PEM block, lazily, so two blocks in a row redact separately; a block whose end was cut off goes to the end of the text. */
const PEM = /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const VENDOR_TOKEN = new RegExp(
	[
		"\\bgh[pousr]_[A-Za-z0-9]{20,}",
		"\\bgithub_pat_[A-Za-z0-9_]{20,}",
		"\\bsk-[A-Za-z0-9_-]{16,}",
		"\\bxox[abposr]-[A-Za-z0-9-]{10,}",
		"\\bAKIA[0-9A-Z]{16}\\b",
		"\\bAIza[0-9A-Za-z_-]{35}",
	].join("|"),
	"g",
);
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
/** A key or field name that names a secret. `tokens` (a count) does not. */
const SECRET_NAME =
	"[\\w.-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|secret|token(?!s\\b)|passw(?:or)?d|passwd|pwd|credentials?|authorization|cookie)[\\w.-]*";
const SECRET_FIELD = new RegExp(`^${SECRET_NAME}$`, "i");
/**
 * A key that names a secret, `=` or `:`, then its value (quoted, or up to a delimiter). Also matches
 * a key inside an escaped JSON string (`\"token\":\"x\"`).
 */
const KEY_VALUE = new RegExp(
	`(\\\\?["']?\\b${SECRET_NAME}\\\\?["']?[ \\t]*[:=][ \\t]*)("[^"\\n]*"|'[^'\\n]*'|\\\\?"?[^\\s"'\\\\,;&}]+)`,
	"gi",
);
const LONG_HEX = /(?<![\w-])[0-9a-fA-F]{32,}(?![\w-])/g;
const LONG_BASE64 = /(?<![\w+=-])[A-Za-z0-9_+=-]{32,}(?![\w+=-])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const TS_NET_HOST = /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net\b/gi;
const IPV4 = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w]|\.\d)/g;
const IPV6_ULA = /(?<![\w:])f[cd][0-9a-f]{2}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi;
const IPV6_LINK_LOCAL = /(?<![\w:])fe80(?::[0-9a-f]{0,4}){1,7}(?:%[\w.-]+)?(?![\w:])/gi;
/** A Windows account name may hold spaces ("Jane Doe"): up to three words, when a separator follows. */
const WINDOWS_HOME =
	/(?<![\w])[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)(?!(?:Public|Default|Shared)\b)(?:[^\\/\s"'<>|:*?]+(?: [^\\/\s"'<>|:*?]+){0,2}(?=[\\/])|[^\\/\s"'<>|:*?]+)/g;
const POSIX_HOME = /(?<![\w.~-])\/(?:Users|home)\/(?!(?:Shared|Guest)\b)[^/\s"'<>|:\\]+/g;

function addressKind(a: number, b: number): "tailnet" | "lan" | null {
	if (a === 100 && b >= 64 && b <= 127) return "tailnet";
	if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan";
	return null;
}

/** Digits, upper and lower case all present: a random-looking token, not a word, a path piece or a version. */
function looksRandom(run: string): boolean {
	return /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run);
}

/** A value that carries no secret: a flag, a count, empty, or already redacted. */
function isInertValue(raw: string): boolean {
	const value = raw.replace(/^\\?["']|["']$/g, "");
	return value === "" || value.startsWith("<") || /^(?:true|false|null|undefined|none|\d+)$/i.test(value);
}

/**
 * Only the credentials group of `redactDiagnosticsText` (rule group 1 below): what must never leave this computer
 * whoever reads it, with emails, addresses and home folders left as they are. Pure; for text that is about a
 * person's own machine and work (the bot's demonstration record), where `<email>` and `~` would only blur it.
 */
export function redactSecretText(text: string): string {
	return text
		.replace(URL_USERINFO, `$1${REDACTED_SECRET}@`)
		.replace(PEM, REDACTED_SECRET)
		.replace(JWT, REDACTED_TOKEN)
		.replace(VENDOR_TOKEN, REDACTED_TOKEN)
		.replace(BEARER, `$1${REDACTED_TOKEN}`)
		.replace(KEY_VALUE, (whole, key: string, value: string) =>
			isInertValue(value) ? whole : `${key}${REDACTED_SECRET}`,
		)
		.replace(LONG_HEX, REDACTED_TOKEN)
		.replace(LONG_BASE64, run => (looksRandom(run) ? REDACTED_TOKEN : run));
}

export function redactDiagnosticsText(text: string): string {
	return redactSecretText(text)
		.replace(EMAIL, email => (email.startsWith("git@") ? email : "<email>"))
		.replace(TS_NET_HOST, "<tailnet-host>")
		.replace(IPV4, (whole, a: string, b: string, c: string, d: string) => {
			if ([a, b, c, d].some(octet => Number(octet) > 255)) return whole;
			const kind = addressKind(Number(a), Number(b));
			return kind === "tailnet" ? "<tailnet-ip>" : kind === "lan" ? "<lan-ip>" : whole;
		})
		.replace(IPV6_ULA, address => (/^fd7a:115c:a1e0/i.test(address) ? "<tailnet-ip>" : "<lan-ip>"))
		.replace(IPV6_LINK_LOCAL, "<lan-ip>")
		.replace(WINDOWS_HOME, "~")
		.replace(POSIX_HOME, "~");
}

/** A JSON value with every string redacted, and a string under a field that names a secret blanked whole. */
function redactJsonValue(value: unknown, secretField: boolean): unknown {
	if (typeof value === "string")
		return secretField && !isInertValue(value) ? REDACTED_SECRET : redactDiagnosticsText(value);
	if (Array.isArray(value)) return value.map(item => redactJsonValue(item, secretField));
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			redactDiagnosticsText(key),
			redactJsonValue(item, SECRET_FIELD.test(key)),
		]),
	);
}

/** One JSON document redacted value by value (so it stays valid JSON), in stock's own layout; null when it is not JSON. */
function redactJsonText(text: string, indent: number): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	return JSON.stringify(redactJsonValue(parsed, false), null, indent);
}

/**
 * A text file of a diagnostic bundle (stock's `/dump all|anon` members). `.json` and `.jsonl` are redacted value by
 * value so the file still parses; a document or line that is not JSON, and every other file, as plain text.
 */
export function redactDiagnosticsFile(name: string, text: string): string {
	if (/\.jsonl$/i.test(name)) {
		return text
			.split("\n")
			.map(line => (line.trim() === "" ? line : (redactJsonText(line, 0) ?? redactDiagnosticsText(line))))
			.join("\n");
	}
	if (/\.json$/i.test(name)) {
		const body = text.replace(/\n$/, "");
		const redacted = redactJsonText(body, /^[[{]\n/.test(body) ? 2 : 0);
		return redacted === null ? redactDiagnosticsText(text) : `${redacted}${text.endsWith("\n") ? "\n" : ""}`;
	}
	return redactDiagnosticsText(text);
}
