/**
 * Insights › This session › Usage by model: the main agent and its subagents often run on one model, so each row
 * leads with who ran on it (never two rows that read alike), and the section keeps the page's section gap.
 * Linkedom harness (no jsdom in this repo).
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionStats } from "../../../shared/rpc-types";
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

// After the linkedom globals above: react-dom and the components read `document`/`window` when they load.
const { createRoot } = await import("react-dom/client");
const { ModelUsage } = await import("./ModelUsage");
const { useModelStore } = await import("../../stores/model");
const { useSubagentsStore } = await import("../../stores/subagents");

const stats = {
	assistantMessages: 7,
	tokens: { total: 381_700 },
	cost: 1.84,
} as unknown as SessionStats;

let container: InstanceType<typeof HTMLElement>;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as InstanceType<typeof HTMLElement>;
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ModelUsage stats={stats} />
			</I18nProvider>,
		);
	});
}

function subagent(id: string): [string, unknown] {
	return [
		id,
		{
			id,
			index: 0,
			agent: "task",
			status: "completed",
			lastUpdate: 0,
			progress: { resolvedModel: "anthropic/claude-sonnet-5-5", requests: 11, tokens: 64_000, cost: 1.05 },
		},
	];
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	useModelStore.setState({ model: null });
	useSubagentsStore.setState({ subagents: new Map() });
});

describe("ModelUsage", () => {
	it("tells the main agent's row from its subagents' when one model serves both", async () => {
		useModelStore.setState({ model: { provider: "anthropic", id: "claude-sonnet-5-5" } as never });
		useSubagentsStore.setState({ subagents: new Map([subagent("a"), subagent("b")]) as never });
		await mount();

		const rows = Array.from(container.querySelectorAll("[data-model-usage] > li")).map(row => row.textContent ?? "");
		expect(rows).toHaveLength(2);
		expect(rows.some(row => row.startsWith("Main agent"))).toBe(true);
		expect(rows.some(row => row.startsWith("Subagents: 2"))).toBe(true);
		expect(rows.every(row => row.includes("anthropic/claude-sonnet-5-5"))).toBe(true);
		// The section carries its own top margin: SectionTitle drops it as a first child.
		expect(container.querySelector("section")?.getAttribute("class")).toContain("mt-8");
	});
});
