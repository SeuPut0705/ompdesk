import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { GenericRenderer } from "./GenericRenderer";
import { getToolHeader, getToolRenderer } from "./index";
import { McpRenderer, parseMcpToolName } from "./McpRenderer";
import { ThinkRenderer } from "./ThinkRenderer";
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
