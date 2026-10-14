import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { AstGrepRenderer } from "./AstGrepRenderer";
import { WaitRenderer } from "./CoordinationRenderer";
import { EditRenderer } from "./EditRenderer";
import { EvalRenderer } from "./EvalRenderer";
import { GenericRenderer } from "./GenericRenderer";
import { GlobRenderer } from "./GlobRenderer";
import { GrepRenderer } from "./GrepRenderer";
import { getToolHeader, getToolRenderer } from "./index";
import { LspRenderer } from "./LspRenderer";
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

describe("ast_grep (stock tools/ast-grep.ts, gallery fixture)", () => {
	const display = [
		"# packages/tui/src/components/",
		"## SearchBox.tsx",
		'*18│  const [query, setQuery] = useState("");',
		'  meta: $A=""',
		"## StatusBar.tsx",
		"*27│  const [expanded, setExpanded] = useState(false);",
		"  meta: $A=false",
	].join("\n");

	it("states counts, scope and searched files, and keeps metavariable bindings", async () => {
		await mount(
			<AstGrepRenderer
				args={{ pat: "useState($A)", path: "packages/tui/src/components" }}
				result={{
					content: [{ type: "text", text: "model text" }],
					details: {
						matchCount: 2,
						fileCount: 2,
						filesSearched: 14,
						limitReached: true,
						scopePath: "packages/tui/src/components",
						displayContent: display,
					},
				}}
			/>,
		);
		const text = container.textContent ?? "";
		expect(text).toContain("2 matches");
		expect(text).toContain("2 files");
		expect(text).toContain("in packages/tui/src/components");
		expect(text).toContain("searched 14");
		expect(text).toContain("packages/tui/src/components/SearchBox.tsx");
		expect(text).toContain('$A=""');
		expect(text).toContain("limit reached; narrow path or increase limit");
		expect(text).not.toContain("model text");
	});

	it("warns that an empty result with parse errors may be mis-scoped", async () => {
		await mount(
			<AstGrepRenderer
				args={{ pat: "foo(" }}
				result={{
					content: [{ type: "text", text: "No matches" }],
					details: {
						matchCount: 0,
						fileCount: 0,
						filesSearched: 3,
						limitReached: false,
						parseErrors: ["a.ts: bad"],
					},
				}}
			/>,
		);
		expect(container.textContent).toContain("may be mis-scoped");
		expect(container.textContent).toContain("1 parse issue");
	});
});

describe("glob and grep limits (stock tools/glob.ts, tools/grep.ts)", () => {
	it("calls an empty timed-out glob incomplete and names skipped paths", async () => {
		await mount(
			<GlobRenderer
				args={{ pattern: "**/*.ts" }}
				result={{
					content: [{ type: "text", text: "" }],
					details: { fileCount: 0, files: [], timedOut: true, missingPaths: ["vendor/"] },
				}}
			/>,
		);
		expect(container.textContent).toContain("scan incomplete");
		expect(container.textContent).toContain("timed out");
		expect(container.textContent).toContain("Skipped missing paths: vendor/");
	});

	it("says why a glob listing was cut", async () => {
		await mount(
			<GlobRenderer
				args={{ pattern: "**/*" }}
				result={{
					content: [{ type: "text", text: "a.ts" }],
					details: { fileCount: 1, files: ["a.ts"], resultLimitReached: 1000, truncated: true },
				}}
			/>,
		);
		expect(container.textContent).toContain("Truncated: limit 1000 results");
	});

	it("marks grep output cut at the column cap and names missing paths", async () => {
		await mount(
			<GrepRenderer
				args={{ pattern: "retry" }}
				result={{
					content: [{ type: "text", text: "" }],
					details: {
						matchCount: 1,
						fileCount: 1,
						files: ["src/a.ts"],
						displayContent: "*3│const retry = 1;",
						missingPaths: ["gone/"],
						meta: { limits: { columnTruncated: { maxColumn: 500 } } },
					},
				}}
			/>,
		);
		expect(container.textContent).toContain("truncated");
		expect(container.textContent).toContain("Skipped missing paths: gone/");
	});
});

describe("lsp server failures (stock tools/lsp.ts)", () => {
	it("shows a failed server instead of a clean result", async () => {
		await mount(
			<LspRenderer
				args={{ action: "diagnostics", file: "src/a.ts" }}
				result={{
					content: [{ type: "text", text: "✗ src/a.ts: all language servers failed (spawn ENOENT)" }],
				}}
			/>,
		);
		const status = container.querySelector("[data-lsp-server-status]");
		expect(status?.textContent).toBe("src/a.ts: all language servers failed (spawn ENOENT)");
		expect(container.querySelector("pre")).toBeNull();
	});
});

describe("wait job details (stock tools/wait.ts JobSnapshot)", () => {
	it("shows a running agent's estimate, model and parent, and an interrupted wait", async () => {
		await mount(
			<WaitRenderer
				args={{}}
				result={{
					content: [{ type: "text", text: "1 job running." }],
					details: {
						op: "wait",
						interrupted: true,
						jobs: [
							{
								id: "job_b2",
								type: "task",
								status: "running",
								label: "Migrate rate limiter",
								durationMs: 9_000,
								completionPercent: 40,
								resolvedModel: "anthropic/claude-sonnet-4-5",
							},
						],
						agents: [{ id: "Scout", parentId: "Main", ageMs: 3_000, live: true }],
					},
				}}
			/>,
		);
		expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0.4");
		expect(container.textContent).toContain("anthropic/claude-sonnet-4-5");
		expect(container.textContent).toContain("← Main");
		expect(container.textContent).toContain("interrupted by a message");
	});
});

describe("prose devices (stock tools/resolve.ts, report-tool-issue.ts)", () => {
	it("renders a pending propose write as the plan, not key/value rows", async () => {
		const Renderer = getToolRenderer("write");
		const args = { path: "xd://propose", content: "## Plan\n\n- **step** one" };
		await mount(<Renderer args={args} isPartial result={undefined} />);
		expect(container.querySelector("[data-tool-device-note] strong")?.textContent).toBe("step");
		const header = getToolHeader("write", args);
		expect(header.labelKey).toBe("tools.label.propose");
		expect(header.target).toBe("## Plan");
	});
});

describe("eval cells (stock tools/eval.ts EvalToolDetails)", () => {
	it("gives each cell its code, status, time and output, and display values a tree", async () => {
		await mount(
			<EvalRenderer
				args={{
					cells: [
						{ language: "py", title: "load", code: "x = 1" },
						{ language: "py", title: "print", code: "print(x)" },
					],
				}}
				result={{
					content: [{ type: "text", text: "1" }],
					details: {
						languages: ["python"],
						jsonOutputs: [{ rows: 3 }],
						notice: "Fell back to the subprocess kernel",
						cells: [
							{
								index: 0,
								title: "load",
								code: "x = 1",
								language: "python",
								output: "",
								status: "complete",
								durationMs: 12,
							},
							{
								index: 1,
								title: "print",
								code: "print(x)",
								language: "python",
								output: "1",
								status: "error",
								exitCode: 1,
							},
						],
					},
				}}
			/>,
		);
		const cells = container.querySelectorAll("[data-eval-cell]");
		expect(cells.length).toBe(2);
		expect(cells[0]?.textContent).toContain("load");
		expect(cells[1]?.textContent).toContain("exit 1");
		expect(container.textContent).toContain("2 cells");
		expect(container.textContent).toContain("Fell back to the subprocess kernel");
		expect(treeText()).toEqual(["rows: 3"]);
		expect(getToolHeader("eval", { cells: [{ language: "py", title: "load" }] }).target).toBe("load");
	});
});
