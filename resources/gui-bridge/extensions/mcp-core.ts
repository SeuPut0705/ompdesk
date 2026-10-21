/**
 * The pure rules behind the Settings MCP list (extensions/mcp.ts): why a server is off, whether it needs a sign-in,
 * and the config `adopt` copies into omp's own mcp.json. Dependency-free so they are tested without omp.
 *
 * `offReasonOf` follows stock's extensions dashboard (`resolveState` in pi-coding-agent
 * `modes/components/extensions/state-manager.ts`) for the order of its checks: an item turned off, then the provider
 * turned off, then a foreign tool's `~/` config not opted in. Two refinements stock folds into "item-disabled": a
 * foreign server whose own tool also turns it off reads as foreign (adopting it fixes both), and an item turned off
 * in the other tool's own file is told apart from one omp's config turned off. Pinned against stock's dashboard by
 * src/main/bridge-mcp-stock.test.ts.
 */
import type { McpOffReason } from "./mcp-contracts";

export interface McpOffFacts {
	/** Stock's discovery with startup's filters loads it (`loadAllMCPConfigs`). */
	active: boolean;
	/** In the user mcp.json `disabledServers` denylist. */
	denied: boolean;
	/** The declaring source says `enabled: false`. */
	sourceDisabled: boolean;
	/** In the user mcp.json `enabledServers` allowlist (overrides a source's `enabled: false`, never the denylist). */
	forced: boolean;
	/** omp's own user or project mcp.json declares it. */
	ownConfig: boolean;
	/** Where the winning declaration came from; absent for a name only the denylist or the live manager knows. */
	source?: { provider: string; providerName: string; level: "user" | "project" | "native"; origin?: string };
	/** `isProviderEnabled(source.provider)`. */
	providerEnabled: boolean;
	/** `isUserSourceEnabled(source.provider)`: a foreign tool's `~/` config is opted in. */
	userSourceEnabled: boolean;
	/** `mcp.enableProjectConfig`. */
	projectConfigEnabled: boolean;
}

export function offReasonOf(facts: McpOffFacts): McpOffReason | undefined {
	if (facts.active) return undefined;
	if (facts.denied) return { kind: "disabled" };
	const source = facts.source;
	if (!source) return undefined;
	const tool = { tool: source.providerName, provider: source.provider };
	if (!facts.providerEnabled) return { kind: "toolOff", ...tool };
	// Stock: omp's own Claude-plugin roots (`origin` not "claude") load without the `~/` opt-in.
	const ompPluginRoot =
		source.provider === "claude-plugins" && source.origin !== undefined && source.origin !== "claude";
	if (!facts.ownConfig && source.level === "user" && !facts.userSourceEnabled && !ompPluginRoot)
		return { kind: "otherTool", ...tool };
	if (facts.sourceDisabled && !facts.forced)
		return facts.ownConfig ? { kind: "disabled" } : { kind: "offInTool", ...tool };
	if (source.level === "project" && !facts.projectConfigEnabled) return { kind: "projectConfigOff" };
	return undefined;
}

export type McpAuthState = "none" | "authorized" | "expired" | "required";

export interface McpAuthFacts {
	/** A config could be resolved for the server. */
	configured: boolean;
	/** A stored OAuth credential: undefined when none, else whether it is still valid. */
	credential?: { valid: boolean };
	/** The config carries an Authorization header. */
	headerAuth: boolean;
	/** The config declares OAuth (`auth.type: "oauth"` or an `oauth` block). */
	declaresOAuth: boolean;
	/** The last connect failed with an OAuth challenge (stock `analyzeAuthError(…).requiresAuth`). */
	challenged: boolean;
}

/**
 * A server that challenges for OAuth needs a sign-in even when its config says nothing about auth: an http server
 * added by its url alone (Higgsfield, Mobbin) declares nothing and answers 401 with `WWW-Authenticate`. A
 * credential it still refuses reads as expired.
 */
export function authStateOf(facts: McpAuthFacts): McpAuthState {
	if (!facts.configured) return "none";
	if (facts.credential) return facts.credential.valid && !facts.challenged ? "authorized" : "expired";
	if (facts.headerAuth) return "authorized";
	if (facts.declaresOAuth || facts.challenged) return "required";
	return "none";
}

/** Capability-item fields that are not part of an on-disk server entry. */
const NOT_CONFIG: Record<string, true> = { name: true, _source: true, _shadowed: true, transport: true, enabled: true };

/**
 * The entry `adopt` writes into omp's user mcp.json for a server another tool declares: its definition as stock
 * discovered it (the `type` stock's `inferMcpTransport` gives it), without the other tool's `enabled: false`
 * (adopting is the person turning it on) or discovery's bookkeeping.
 *
 * Discovery already put the values of the variables the other tool forwards (Codex `env_vars`,
 * `bearer_token_env_var`, `env_http_headers`) into `env` and `headers`. Written as they are, a token from the
 * environment would land in mcp.json, so a value that is exactly an environment variable's goes back to `${NAME}`
 * (omp's mcp.json expands it at load), and so does a variable's value inside a header (`Bearer <token>`).
 */
export function adoptedEntry(
	server: Record<string, unknown>,
	type: string,
	environment: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
	const entry: Record<string, unknown> = { type };
	for (const [key, value] of Object.entries(server)) {
		if (NOT_CONFIG[key] !== true && value !== undefined) entry[key] = value;
	}
	if (isStringRecord(entry.env)) {
		entry.env = Object.fromEntries(
			Object.entries(entry.env).map(([key, value]) => [key, environment[key] === value ? `\${${key}}` : value]),
		);
	}
	if (isStringRecord(entry.headers)) {
		// Longest values first, so a variable whose value contains another's is replaced whole.
		const secrets = Object.entries(environment)
			.filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].length >= MIN_SECRET_CHARS)
			.sort((a, b) => b[1].length - a[1].length);
		entry.headers = Object.fromEntries(
			Object.entries(entry.headers).map(([key, value]) => [
				key,
				secrets.reduce((text, [name, secret]) => text.split(secret).join(`\${${name}}`), value),
			]),
		);
	}
	return entry;
}

/** Shorter values (`1`, `true`, a short path) would be replaced inside unrelated header text. */
const MIN_SECRET_CHARS = 8;

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every(item => typeof item === "string")
	);
}
