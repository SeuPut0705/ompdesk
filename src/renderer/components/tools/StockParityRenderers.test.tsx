import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { EditRenderer } from "./EditRenderer";
import { GenericRenderer } from "./GenericRenderer";
import { getToolHeader, getToolRenderer } from "./index";
import { McpRenderer, parseMcpToolName } from "./McpRenderer";
import { ReadRenderer } from "./ReadRenderer";
import { ThinkRenderer } from "./ThinkRenderer";
import { WriteRenderer } from "./WriteRenderer";
import { YieldRenderer } from "./YieldRenderer";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
let container: HTMLElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

const treeText = () => [...container.querySelectorAll('[role="treeitem"]')].map(row => row.textContent);

// Shapes below come from stock's `omp gallery` fixtures (pi-coding-agent/src/cli/gallery-fixtures).
describe("generic renderer (stock tools/default-renderer.ts)", () => {
	it("hides the intent and streaming buffer, and reads JSON output as a tree", async () => {
		await mount(
			<GenericRenderer
				args={{ goal: "trace the retry path", i: "Checkpointing", __partialJson: "{" }}
				result={{ content: [{ type: "text", text: '{"rewound":true,"report":{"lines":3}}' }] }}
			/>,
		);
		expect(container.textContent).toContain("trace the retry path");
		expect(container.textContent).not.toContain("Checkpointing");
		expect(container.textContent).not.toContain("__partialJson");
		expect(treeText()).toEqual(["rewound: true", "report: {1}", "lines: 3"]);
	});

	it("says (no output) for an empty result and folds details", async () => {
		await mount(
			<GenericRenderer
				args={{}}
				result={{ content: [{ type: "text", text: "" }], details: { skill: "release", meta: {} } }}
			/>,
		);
		expect(container.textContent).toContain("(no output)");
		const details = container.querySelector("details");
		expect(details?.hasAttribute("open")).toBe(false);
		expect(details?.textContent).toContain("skill");
		// `meta` is the spill wrapper's record, restated as a notice, never a row.
		expect(details?.textContent).not.toContain("meta");
	});

	it("restates a truncated result in the UI language", async () => {
		await mount(
			<GenericRenderer
				args={{}}
				result={{
					content: [{ type: "text", text: "a\nb\n[Showing 2 of 90 lines]" }],
					details: { meta: { truncation: { totalLines: 90, outputLines: 2 } } },
				}}
			/>,
		);
		expect(container.querySelector("pre")?.textContent).toBe("a\nb");
		expect(container.textContent).toContain("[Showing 2 of 90 lines]");
	});
});

describe("think (stock tools/think.ts)", () => {
	it("shows the thoughts as markdown and never the model-facing result", async () => {
		await mount(
			<ThinkRenderer
				args={{ thoughts: "The retry loop re-reads the **config** after every failure." }}
				result={{ content: [{ type: "text", text: "------" }], details: { recorded: true } }}
			/>,
		);
		expect(container.querySelector("strong")?.textContent).toBe("config");
		expect(container.textContent).not.toContain("------");
		expect(container.textContent).not.toContain("recorded");
		expect(getToolRenderer("think")).toBe(ThinkRenderer);
		expect(getToolHeader("think", {}).labelKey).toBe("tools.label.think");
	});
});

describe("yield (stock tools/yield.ts)", () => {
	const data = { summary: "Two races in the session store's flush path.", confidence: 0.8 };

	it("shows the submitted data, not the reply", async () => {
		await mount(
			<YieldRenderer
				args={{ data }}
				result={{ content: [{ type: "text", text: "Result submitted." }], details: { status: "success", data } }}
			/>,
		);
		expect(container.textContent).not.toContain("Result submitted.");
		expect(container.textContent).toContain("2 fields");
		expect(treeText()).toEqual([`summary: "${data.summary}"`, "confidence: 0.8"]);
	});

	it("names a section target and the schema override", async () => {
		await mount(
			<YieldRenderer
				args={{ type: ["findings", "risks"], data: "- **race** in flush" }}
				result={{
					content: [{ type: "text", text: "Result submitted." }],
					details: {
						status: "success",
						type: ["findings", "risks"],
						data: "- **race** in flush",
						schemaOverridden: true,
					},
				}}
			/>,
		);
		expect(container.textContent).toContain("findings, risks");
		expect(container.textContent).toContain("schema overridden");
		expect(container.querySelector("strong")?.textContent).toBe("race");
	});

	it("states a rejected submission and the last-turn fallback", async () => {
		const error = "Output does not match schema: /confidence must be number.";
		await mount(<YieldRenderer args={{ data }} isError result={{ content: [{ type: "text", text: error }] }} />);
		expect(container.querySelector("pre")?.textContent).toBe(error);
		await act(async () => root.unmount());
		await mount(
			<YieldRenderer
				args={{ type: ["notes"] }}
				result={{ content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } }}
			/>,
		);
		expect(container.textContent).toContain("Takes the last message as this section");
	});
});

describe("MCP tools (stock tools/mcp.ts)", () => {
	it("splits names at the first underscore, as stock parseMCPToolName does", () => {
		expect(parseMcpToolName("mcp__rea_open_binary")).toEqual({ server: "rea", tool: "open_binary" });
		expect(parseMcpToolName("mcp__github")).toBeNull();
		expect(parseMcpToolName("read")).toBeNull();
	});

	it("labels the call by server and tool and renders JSON as a tree", async () => {
		const header = getToolHeader("mcp__rea_open_binary", { path: "/bin/ls" });
		expect(header.labelKey).toBe("tools.label.mcpTool");
		expect(header.labelParams).toEqual({ server: "rea", tool: "open_binary" });
		expect(getToolRenderer("mcp__rea_open_binary")).toBe(McpRenderer);
		await mount(
			<McpRenderer
				args={{ path: "/bin/ls", i: "Opening" }}
				result={{
					content: [{ type: "text", text: '{"format":"mach-o","arch":"arm64"}' }],
					details: {
						serverName: "rea",
						mcpToolName: "open_binary",
						providerName: "MCP Config",
						rawContent: [{ type: "text", text: "raw duplicate" }],
						structuredContent: { format: "mach-o" },
					},
				}}
			/>,
		);
		expect(container.textContent).toContain("MCP Config");
		expect(container.textContent).not.toContain("Opening");
		expect(container.textContent).not.toContain("raw duplicate");
		expect(treeText().slice(0, 2)).toEqual(['format: "mach-o"', 'arch: "arm64"']);
		expect(container.querySelector("details summary")?.textContent).toBe("Structured content");
	});

	it("shows a failed call as error text", async () => {
		await mount(
			<McpRenderer
				args={{}}
				isError
				result={{
					content: [{ type: "text", text: "server exited" }],
					details: { serverName: "rea", mcpToolName: "x", isError: true },
				}}
			/>,
		);
		expect(container.querySelector("pre")?.textContent).toBe("server exited");
	});
});

// `FileDiagnosticsResult` as pi-coding-agent `lsp/writethrough.ts` builds it, messages from `lsp/utils.ts` formatDiagnostic.
const diagnostics = {
	server: "typescript-language-server",
	messages: [
		"src/auth.ts:12:5 [warning] [ts] 'token' is declared but never used. (6133)",
		"src/auth.ts:4:1 [error] [ts] Cannot find name 'Session'. (2304)",
	],
	summary: "1 error(s), 1 warning(s)",
	errored: true,
};

describe("LSP diagnostics after a file change (stock native-view diagnosticsSection)", () => {
	it("lists an edit's diagnostics most severe first", async () => {
		await mount(
			<EditRenderer
				args={{ path: "src/auth.ts" }}
				result={{
					content: [{ type: "text", text: "Updated src/auth.ts" }],
					details: { diff: "@@ -1 +1 @@\n-a\n+b", diagnostics },
				}}
			/>,
		);
		const section = container.querySelector("[data-tool-diagnostics]");
		expect(section?.textContent).toContain("Diagnostics");
		expect(section?.textContent).toContain("1 error(s), 1 warning(s)");
		const rows = section?.textContent ?? "";
		expect(rows.indexOf("Cannot find name")).toBeLessThan(rows.indexOf("declared but never used"));
		expect(rows).toContain("4:1");
	});

	it("marks an executable write and counts its diagnostics", async () => {
		await mount(
			<WriteRenderer
				args={{ path: "bin/run.sh", content: "#!/bin/sh\necho hi" }}
				result={{
					content: [{ type: "text", text: "Wrote bin/run.sh" }],
					details: { madeExecutable: true, diagnostics },
				}}
			/>,
		);
		expect(container.textContent).toContain("executable");
		expect(container.querySelector(".omp-tool-diagnostics")?.textContent).toBe("2 diagnostics");
	});
});

describe("cfg:// settings (stock tools/cfg-render.ts)", () => {
	it("shows a write's scope, outcome and previous → value", async () => {
		await mount(
			<WriteRenderer
				args={{ path: "cfg://advisor/enabled/save", content: "true" }}
				result={{
					content: [{ type: "text", text: "advisor.enabled = true (saved)" }],
					details: {
						cfg: {
							path: "advisor.enabled",
							save: true,
							previous: "false",
							value: "true",
							outcome: "applied",
							effective: "false",
						},
					},
				}}
			/>,
		);
		const card = container.querySelector("[data-tool-cfg-write]");
		expect(card?.textContent).toContain("advisor.enabled");
		expect(card?.textContent).toContain("saved");
		expect(card?.textContent).toContain("false → true");
		expect(card?.textContent).toContain("a higher-precedence layer overrides the saved value");
	});

	it("says when the user declined", async () => {
		await mount(
			<WriteRenderer
				args={{ path: "cfg://theme", content: "dark" }}
				result={{
					content: [{ type: "text", text: "declined" }],
					details: { cfg: { path: "theme", save: false, previous: "light", value: "dark", outcome: "declined" } },
				}}
			/>,
		);
		expect(container.textContent).toContain("this session");
		expect(container.textContent).toContain("declined");
	});

	it("reads a settings listing as YAML with its counts", async () => {
		await mount(
			<ReadRenderer
				args={{ path: "cfg://advisor" }}
				result={{
					content: [{ type: "text", text: "advisor:\n  enabled: true\n  model: smol" }],
					details: { cfg: { path: "advisor", count: 2, modified: 1 } },
				}}
			/>,
		);
		expect(container.querySelector("[data-read-meta]")?.textContent).toBe("2 settings · 1 modified");
		expect(container.textContent).toContain("advisor");
	});
});

describe("read extras (stock tools/read.ts, tools/fetch.ts)", () => {
	it("states a URL's redirect, content type and method", async () => {
		await mount(
			<ReadRenderer
				args={{ path: "http://example.com/docs" }}
				result={{
					content: [{ type: "text", text: "# Docs" }],
					details: {
						kind: "url",
						url: "http://example.com/docs",
						finalUrl: "https://www.example.com/docs/",
						contentType: "text/html",
						method: "readability",
						notes: ["converted to markdown"],
						truncated: true,
					},
				}}
			/>,
		);
		expect(container.querySelector("[data-read-meta]")?.textContent).toBe(
			"from example.com · text/html · readability · converted to markdown",
		);
		expect(container.textContent).toContain("[Output truncated]");
	});

	it("names a corrected path, elided spans and conflicts", async () => {
		await mount(
			<ReadRenderer
				args={{ path: "src/sesion.ts" }}
				result={{
					content: [{ type: "text", text: "export {}" }],
					details: {
						resolvedPath: "/repo/src/session.ts",
						suffixResolution: { from: "src/sesion.ts", to: "src/session.ts" },
						summary: { lines: 120, elidedSpans: 3, elidedLines: 80 },
						conflictCount: 2,
					},
				}}
			/>,
		);
		expect(container.querySelector("[data-read-meta]")?.textContent).toBe(
			"corrected from src/sesion.ts · summary: 3 elided spans",
		);
		expect(container.textContent).toContain("2 conflicts");
	});
});
