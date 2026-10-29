/**
 * Context breakdown contract (Insights › Stats › This session): the
 * categories (stock's, with tools split by source and context files pulled
 * out) must stay readable even when the host publishes no context window for
 * the model, and Inspect opens every entry with its text. Linkedom harness
 * (no jsdom in this repo).
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcContextInspectResult, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";

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

const categories = {
	systemPrompt: 1_000,
	systemContext: 150,
	memoryFiles: 50,
	builtinTools: 5_000,
	mcpTools: 1_400,
	extensionTools: 0,
	skills: 300,
	messages: 8_100,
};

const entries: RpcContextInspectResult["entries"] = [
	{ id: "tool:bash", category: "builtinTools", label: "bash", tokens: 3_000 },
	{ id: "tool:read", category: "builtinTools", label: "read", tokens: 2_000 },
	{ id: "tool:mcp__rea_call", category: "mcpTools", label: "mcp__rea_call", tokens: 1_400 },
	{ id: "deferred:mcp__rea_catalog", category: "mcpTools", label: "mcp__rea_catalog", tokens: 0, deferred: true },
	{ id: "file:/repo/AGENTS.md", category: "memoryFiles", label: "/repo/AGENTS.md", tokens: 50 },
	{ id: "msg:0:1", category: "messages", label: "Fix the build", role: "user", tokens: 40 },
];

const getContextInspect = vi.fn<(withEntries?: boolean) => Promise<RpcResponse>>();
const getContextEntry = vi.fn<(id: string) => Promise<RpcResponse>>();
Object.assign(window, { omp: { rpc: { getContextInspect, getContextEntry } } });

// After the linkedom globals above: react-dom and the components read `document`/`window` when they load.
const { createRoot } = await import("react-dom/client");
const { ContextBreakdown } = await import("./ContextBreakdown");
const { planBlocks } = await import("./ContextInspector");

let container: InstanceType<typeof HTMLElement>;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function openWith(data: Omit<RpcContextInspectResult, "entries">): Promise<void> {
	getContextInspect.mockImplementation(async withEntries => ({
		command: "get_context_inspect",
		data: { ...data, entries: withEntries ? entries : [] },
		success: true,
		type: "response",
	}));
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ContextBreakdown />
			</I18nProvider>,
		);
	});
	await flush();
}

function button(text: string): HTMLElement {
	const found = [...document.querySelectorAll("button")].find(node => node.textContent?.includes(text));
	if (!found) throw new Error(`no button with "${text}"`);
	return found as unknown as HTMLElement;
}

async function click(target: HTMLElement): Promise<void> {
	await act(async () => {
		target.dispatchEvent(new Event("click", { bubbles: true }));
	});
	await flush();
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	for (const node of [...document.body.childNodes]) node.remove();
	getContextInspect.mockReset();
	getContextEntry.mockReset();
});

describe("ContextBreakdown", () => {
	it("lists the measured categories when Core has no window for the model", async () => {
		await openWith({ categories, contextWindow: 0, usedTokens: 16_000, anchored: false, model: "mimo-v2.6-pro" });
		// The card reads totals only; the inspector asks for entries.
		expect(getContextInspect).toHaveBeenCalledWith(false);
		const text = document.body.textContent ?? "";
		expect(text).not.toContain("no model is selected");
		expect(text).toContain("Messages");
		expect(text).toContain("16.0k tokens used");
		// Shares of a window that does not exist would be invented numbers.
		expect(text).not.toContain("%");
		expect(text).not.toContain("Free");
	});

	it("splits tools by source and shows context files, sized against a known window", async () => {
		await openWith({ categories, contextWindow: 32_000, usedTokens: 16_000, anchored: true, model: "known-model" });
		const text = document.body.textContent ?? "";
		expect(text).toContain("16.0k / 32.0k tokens (50% used)");
		expect(text).toContain("Built-in tools");
		expect(text).toContain("MCP tools");
		expect(text).toContain("Instruction files");
		// An empty category stays out of the legend.
		expect(text).not.toContain("Extension tools");
		expect(text).toContain("Free");
	});
});

describe("ContextInspector", () => {
	it("lists entries by size, filters by category, marks deferred tools and opens an entry's text", async () => {
		await openWith({ categories, contextWindow: 32_000, usedTokens: 16_000, anchored: true, model: "known-model" });
		await click(button("Inspect"));
		expect(getContextInspect).toHaveBeenLastCalledWith(true);
		const sheet = document.querySelector('[role="dialog"]');
		expect(sheet?.textContent).toContain("Each block ≈ 160 tokens");
		const rows = () => [...(sheet?.querySelectorAll("li") ?? [])].map(row => row.textContent ?? "");
		// Largest first; the deferred MCP tool shows its badge instead of a count.
		expect(rows()[0]).toContain("bash");
		expect(rows().find(row => row.includes("mcp__rea_catalog"))).toContain("Deferred");

		await click(button("MCP tools"));
		expect(button("MCP tools").getAttribute("aria-pressed")).toBe("true");
		expect(rows()).toHaveLength(2);
		expect(rows().every(row => row.includes("mcp__"))).toBe(true);

		getContextEntry.mockResolvedValue({
			command: "get_context_entry",
			data: { text: "x".repeat(32_000), totalChars: 40_000, truncated: true },
			success: true,
			type: "response",
		});
		await click(button("mcp__rea_call"));
		expect(getContextEntry).toHaveBeenCalledWith("tool:mcp__rea_call");
		expect(button("mcp__rea_call").getAttribute("aria-expanded")).toBe("true");
		expect(sheet?.textContent).toContain("Showing the first 32,000 of 40,000 characters");
	});

	it("warns when the context is larger than the window", async () => {
		await openWith({ categories, contextWindow: 10_000, usedTokens: 16_000, anchored: true, model: "small" });
		await click(button("Inspect"));
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
			"The context is larger than the model's window",
		);
	});

	it("plans 200 blocks, keeps a small category visible and trims an overfull grid from the largest", () => {
		const small = planBlocks({ ...categories, messages: 0, systemPrompt: 0 }, 1_000);
		expect(small).toHaveLength(200);
		// 50 tokens at 1,000 per block still gets one block.
		expect(small.filter(category => category === "memoryFiles")).toHaveLength(1);
		const full = planBlocks({ ...categories, messages: 1_000_000 }, 1_000);
		expect(full).toHaveLength(200);
		expect(full).not.toContain("free");
		expect(full.filter(category => category === "memoryFiles")).toHaveLength(1);
	});
});
