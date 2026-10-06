/**
 * Contract tests for the MCP add-server wizard and server card:
 * - name validation parity with the agent's validateServerName (colon included)
 * - required-field validation per transport
 * - RpcMcpServerInput assembly (stdio vs http/sse, empty rows dropped)
 * - mcp_test payload → inline result mapping (first 10 tools + "+N more")
 * - SSR rendering of wizard/card states (renderToStaticMarkup; the Modal
 *   wrapper portals, so tests render the portal-free form/card directly)
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcMcpServerInfo, RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { MCP_TEST_SHOWN_LIMIT, McpTestResultView, summarizeMcpTestData } from "./McpFeedback";
import { MCP_AUTH_BADGE_VARIANT, MCP_STATUS_VARIANT, McpServerCard } from "./McpServerCard";
import {
	buildMcpServerInput,
	initialMcpWizardValues,
	MCP_SERVER_NAME_PATTERN,
	McpServerWizardForm,
	type McpWizardValues,
	validateMcpServerName,
	validateMcpWizardConfig,
	validateMcpWizardForm,
} from "./McpServerWizard";

interface MockMcpRpc {
	mcpAdd: Mock<(name: string, config: unknown, scope?: string) => Promise<RpcResponse>>;
	mcpTest: Mock<(probe: { name?: string; config?: unknown }) => Promise<RpcResponse>>;
}

function success(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

/** window.omp stub (composer-submit.test.ts pattern): the wizard only touches it on submit/test. */
function installMockOmp(): MockMcpRpc {
	const rpc: MockMcpRpc = {
		mcpAdd: vi.fn(async () => success({ added: true })),
		mcpTest: vi.fn(async () => success({ ok: true, toolNames: [], toolCount: 0 })),
	};
	(globalThis as Record<string, unknown>).window = { omp: { rpc } };
	return rpc;
}

afterEach(() => {
	vi.restoreAllMocks();
	delete (globalThis as Record<string, unknown>).window;
});

function values(partial: Partial<McpWizardValues>): McpWizardValues {
	return { ...initialMcpWizardValues(), ...partial };
}

describe("validateMcpServerName (agent parity)", () => {
	it("matches the agent regex alphabet exactly, colon included", () => {
		expect(MCP_SERVER_NAME_PATTERN.source).toBe("^[a-zA-Z0-9_.:-]+$");
	});

	it("accepts plugin-namespaced colon names and the full alphabet", () => {
		expect(validateMcpServerName("cloudflare:cloudflare-api")).toBeUndefined();
		expect(validateMcpServerName("A_b-c.d:e")).toBeUndefined();
		expect(validateMcpServerName("a".repeat(100))).toBeUndefined();
	});

	it("rejects empty, over-long, and out-of-alphabet names like the agent", () => {
		expect(validateMcpServerName("")).toBe("empty");
		expect(validateMcpServerName("a".repeat(101))).toBe("tooLong");
		expect(validateMcpServerName("has space")).toBe("invalidChars");
		expect(validateMcpServerName("slash/name")).toBe("invalidChars");
		expect(validateMcpServerName("name?")).toBe("invalidChars");
	});
});

describe("validateMcpWizardForm / validateMcpWizardConfig", () => {
	it("requires a name and reports the name error token", () => {
		expect(validateMcpWizardForm(values({ name: "", command: "npx" })).name).toBe("empty");
		expect(validateMcpWizardForm(values({ name: "has space", command: "npx" })).name).toBe("invalidChars");
		expect(validateMcpWizardForm(values({ name: "ok:name", command: "npx" }))).toEqual({});
	});

	it("requires command for stdio only", () => {
		expect(validateMcpWizardConfig(values({ transport: "stdio", command: " " })).command).toBe("required");
		expect(validateMcpWizardConfig(values({ transport: "stdio", command: "npx" }))).toEqual({});
		expect(validateMcpWizardConfig(values({ transport: "http", url: "https://x.test" }))).toEqual({});
	});

	it("requires a valid http(s) URL for http/sse", () => {
		expect(validateMcpWizardConfig(values({ transport: "http", url: "" })).url).toBe("required");
		expect(validateMcpWizardConfig(values({ transport: "sse", url: "ftp://x.test" })).url).toBe("invalid");
		expect(validateMcpWizardConfig(values({ transport: "sse", url: "not a url" })).url).toBe("invalid");
		expect(validateMcpWizardConfig(values({ transport: "sse", url: "https://x.test/sse" }))).toEqual({});
	});
});

describe("buildMcpServerInput", () => {
	it("assembles stdio: trimmed command, args, stringified env; no url/headers keys", () => {
		const input = buildMcpServerInput(
			values({
				transport: "stdio",
				command: "  npx  ",
				args: ["-y", "server"],
				env: { TOKEN: "abc", "  SPACED ": "v", key1: "", EMPTY: "" },
			}),
		);
		expect(input).toEqual({
			transport: "stdio",
			command: "npx",
			args: ["-y", "server"],
			env: { TOKEN: "abc", SPACED: "v" },
		});
		expect("url" in input).toBe(false);
		expect("headers" in input).toBe(false);
	});

	it("omits empty args/env from stdio payloads", () => {
		expect(buildMcpServerInput(values({ transport: "stdio", command: "uvx" }))).toEqual({
			transport: "stdio",
			command: "uvx",
		});
	});

	it("assembles http/sse: trimmed url, stringified headers; no stdio keys", () => {
		const input = buildMcpServerInput(
			values({ transport: "sse", url: " https://x.test/sse ", headers: { Authorization: "Bearer t" } }),
		);
		expect(input).toEqual({ transport: "sse", url: "https://x.test/sse", headers: { Authorization: "Bearer t" } });
		expect("command" in input).toBe(false);
		expect("args" in input).toBe(false);
		expect("env" in input).toBe(false);
	});

	it("omits empty headers from http payloads", () => {
		expect(buildMcpServerInput(values({ transport: "http", url: "https://x.test" }))).toEqual({
			transport: "http",
			url: "https://x.test",
		});
	});
});

describe("summarizeMcpTestData", () => {
	it("keeps the first 10 tool names and counts the remainder", () => {
		const toolNames = Array.from({ length: 12 }, (_, i) => `tool_${i}`);
		const view = summarizeMcpTestData({ ok: true, toolNames, toolCount: 12 });
		expect(view).toEqual({ kind: "ok", toolCount: 12, shown: toolNames.slice(0, MCP_TEST_SHOWN_LIMIT), extra: 2 });
	});

	it("uses toolCount when it exceeds the returned name list", () => {
		const toolNames = Array.from({ length: 12 }, (_, i) => `tool_${i}`);
		const view = summarizeMcpTestData({ ok: true, toolNames, toolCount: 25 });
		expect(view.kind).toBe("ok");
		if (view.kind !== "ok") return;
		expect(view.extra).toBe(15);
	});

	it("handles short and missing tool lists", () => {
		expect(summarizeMcpTestData({ ok: true, toolNames: ["a", "b"], toolCount: 2 })).toEqual({
			kind: "ok",
			toolCount: 2,
			shown: ["a", "b"],
			extra: 0,
		});
		expect(summarizeMcpTestData({ ok: true })).toEqual({ kind: "ok", toolCount: 0, shown: [], extra: 0 });
	});

	it("maps failures and missing payloads to the error view", () => {
		expect(summarizeMcpTestData({ ok: false, error: "boom" })).toEqual({ kind: "error", error: "boom" });
		expect(summarizeMcpTestData(undefined)).toEqual({ kind: "error", error: "" });
	});
});

describe("MCP badge variant maps", () => {
	it("covers every connection status and auth state", () => {
		expect(Object.keys(MCP_STATUS_VARIANT).sort()).toEqual(["connected", "connecting", "disconnected"]);
		expect(Object.keys(MCP_AUTH_BADGE_VARIANT).sort()).toEqual(["authorized", "expired", "none", "required"]);
	});
});

describe("McpServerWizardForm SSR states", () => {
	const render = (initialValues?: Partial<McpWizardValues>): string =>
		renderToStaticMarkup(
			<I18nProvider>
				<McpServerWizardForm initialValues={initialValues} onAdded={() => {}} onCancel={() => {}} />
			</I18nProvider>,
		);

	it("renders the stdio form by default: command/args/env, scope picker, test + submit", () => {
		installMockOmp();
		const html = render();
		expect(html).toContain("Server name");
		expect(html).toContain(">stdio<");
		expect(html).toContain("Command");
		expect(html).toContain("Arguments");
		expect(html).toContain("Environment variables");
		expect(html).toContain("This project only");
		expect(html).toContain("Test connection");
		expect(html).toContain("Add server");
		expect(html).not.toContain("Server URL");
	});

	it("renders url + headers for http, hiding the stdio fields", () => {
		installMockOmp();
		const html = render({ transport: "http" });
		expect(html).toContain("Server URL");
		expect(html).toContain("Headers");
		expect(html).not.toContain("Arguments");
		expect(html).not.toContain("Environment variables");
	});
});

describe("McpTestResultView SSR", () => {
	it("renders success with tool chips and the +N more remainder", () => {
		const toolNames = Array.from({ length: 12 }, (_, i) => `tool_${i}`);
		const html = renderToStaticMarkup(
			<I18nProvider>
				<McpTestResultView view={summarizeMcpTestData({ ok: true, toolNames, toolCount: 12 })} />
			</I18nProvider>,
		);
		expect(html).toContain("Connection OK");
		expect(html).toContain("tool_9");
		expect(html).not.toContain("tool_10");
		expect(html).toContain("+2 more");
	});

	it("renders a copyable failure", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<McpTestResultView view={{ kind: "error", error: "connection refused" }} />
			</I18nProvider>,
		);
		expect(html).toContain("Connection test failed");
		expect(html).toContain("connection refused");
	});
});

describe("McpServerCard SSR", () => {
	function server(partial: Partial<RpcMcpServerInfo>): RpcMcpServerInfo {
		return {
			name: "github",
			transport: "stdio",
			status: "connected",
			toolCount: 3,
			enabled: true,
			authed: false,
			...partial,
		};
	}

	const renderCard = (fixture: RpcMcpServerInfo, reauth: "running" | "cancelling" | null = null): string =>
		renderToStaticMarkup(
			<I18nProvider>
				<McpServerCard
					busy={false}
					confirmingRemove={false}
					disabled={false}
					enabled={fixture.enabled}
					menuOpen={false}
					onCancelRemove={() => {}}
					onConfirmRemove={() => {}}
					onDismissTest={() => {}}
					onMenuAction={() => {}}
					onMenuClose={() => {}}
					onMenuToggle={() => {}}
					onReauthCancel={() => {}}
					reauth={reauth}
					server={fixture}
					testing={false}
					testView={null}
				/>
			</I18nProvider>,
		);

	it("renders scope/transport/auth badges and the stdio command line", () => {
		const html = renderCard(server({ scope: "user", command: "npx -y server", authState: "authorized" }));
		expect(html).toContain("github");
		expect(html).toContain(">stdio<");
		expect(html).toContain("user");
		expect(html).toContain("authorized");
		expect(html).toContain("npx -y server");
	});

	it("renders the url target for http servers", () => {
		const html = renderCard(server({ transport: "http", url: "https://x.test/mcp" }));
		expect(html).toContain("https://x.test/mcp");
	});

	it("shows the reauth-in-flight strip with a cancel action", () => {
		const html = renderCard(server({}), "running");
		expect(html).toContain("Authorization in progress");
		expect(html).toContain("Cancel");
	});
});
