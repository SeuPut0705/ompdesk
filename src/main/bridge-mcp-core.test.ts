import { describe, expect, it } from "vitest";
import {
	adoptedEntry,
	authStateOf,
	type McpOffFacts,
	offReasonOf,
} from "../../resources/gui-bridge/extensions/mcp-core";

const codex = { provider: "codex", providerName: "OpenAI Codex", level: "user" as const };
const off: McpOffFacts = {
	active: false,
	denied: false,
	sourceDisabled: false,
	forced: false,
	ownConfig: false,
	source: codex,
	providerEnabled: true,
	userSourceEnabled: false,
	projectConfigEnabled: true,
};

describe("why an MCP server is off", () => {
	it("says nothing about a server stock loads", () => {
		expect(offReasonOf({ ...off, active: true })).toBeUndefined();
	});

	it("names the other tool a server only lives in, also when that tool turns it off too", () => {
		expect(offReasonOf(off)).toEqual({ kind: "otherTool", tool: "OpenAI Codex", provider: "codex" });
		expect(offReasonOf({ ...off, sourceDisabled: true })).toMatchObject({ kind: "otherTool" });
	});

	it("puts the person's own switch first, and tells omp's config from the other tool's", () => {
		expect(offReasonOf({ ...off, denied: true })).toEqual({ kind: "disabled" });
		const ompOwn = {
			...off,
			ownConfig: true,
			sourceDisabled: true,
			source: { ...codex, provider: "native", level: "native" as const },
		};
		expect(offReasonOf(ompOwn)).toEqual({ kind: "disabled" });
		expect(offReasonOf({ ...off, userSourceEnabled: true, sourceDisabled: true })).toMatchObject({
			kind: "offInTool",
		});
		expect(offReasonOf({ ...off, userSourceEnabled: true, sourceDisabled: true, forced: true })).toBeUndefined();
	});

	it("says a provider turned off as a whole, and project config turned off", () => {
		expect(offReasonOf({ ...off, providerEnabled: false })).toMatchObject({ kind: "toolOff", provider: "codex" });
		const project = { ...off, source: { ...codex, level: "project" as const }, projectConfigEnabled: false };
		expect(offReasonOf(project)).toEqual({ kind: "projectConfigOff" });
	});

	it("loads omp's own Claude plugin roots without the opt-in, as stock does", () => {
		const plugin = {
			...off,
			source: { provider: "claude-plugins", providerName: "Claude", level: "user" as const, origin: "omp" },
		};
		expect(offReasonOf(plugin)).toBeUndefined();
		expect(offReasonOf({ ...plugin, source: { ...plugin.source, origin: "claude" } })).toMatchObject({
			kind: "otherTool",
		});
	});
});

describe("whether an MCP server needs a sign-in", () => {
	const base = { configured: true, headerAuth: false, declaresOAuth: false, challenged: false };
	it("needs one when the server challenged for OAuth, though its config says nothing about auth", () => {
		expect(authStateOf(base)).toBe("none");
		expect(authStateOf({ ...base, challenged: true })).toBe("required");
		expect(authStateOf({ ...base, declaresOAuth: true })).toBe("required");
	});

	it("reads a stored credential the server still refuses, or one past its expiry, as expired", () => {
		expect(authStateOf({ ...base, credential: { valid: true } })).toBe("authorized");
		expect(authStateOf({ ...base, credential: { valid: true }, challenged: true })).toBe("expired");
		expect(authStateOf({ ...base, credential: { valid: false } })).toBe("expired");
		expect(authStateOf({ ...base, headerAuth: true })).toBe("authorized");
	});
});

describe("the entry adopting another tool's server writes", () => {
	it("keeps the definition, drops discovery's fields and the other tool's off switch", () => {
		const server = { name: "docs", _source: {}, enabled: false, transport: "http", url: "https://x/mcp", timeout: 5 };
		expect(adoptedEntry(server, "http", {})).toEqual({ type: "http", url: "https://x/mcp", timeout: 5 });
	});

	it("writes a forwarded variable's name, never its secret value", () => {
		const env = { DOCS_TOKEN: "s3cret-token-value", HOME: "/Users/kim", SHORT: "1" };
		const server = {
			name: "docs",
			command: "docs-mcp",
			env: { DOCS_TOKEN: "s3cret-token-value", MODE: "1" },
			headers: { Authorization: "Bearer s3cret-token-value", "X-Mode": "1" },
		};
		const entry = adoptedEntry(server, "stdio", env);
		// omp's mcp.json reference syntax, expanded when it loads.
		const ref = (name: string) => `\${${name}}`;
		expect(entry.env).toEqual({ DOCS_TOKEN: ref("DOCS_TOKEN"), MODE: "1" });
		expect(entry.headers).toEqual({ Authorization: `Bearer ${ref("DOCS_TOKEN")}`, "X-Mode": "1" });
		expect(JSON.stringify(entry)).not.toContain("s3cret");
	});
});
