import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { ToolCard } from "./ToolCard";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

function call(id: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }],
		timestamp: 1_000,
	};
}

async function renderCards(ids: string[]): Promise<{ root: Root; container: HTMLElement }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const cards: ReactElement[] = ids.map(id => (
		<ToolCard key={id} toolCallId={id} toolName="read" args={{ path: `${id}.ts` }} />
	));
	await act(async () => {
		root.render(<I18nProvider>{cards}</I18nProvider>);
	});
	return { root, container };
}

afterEach(() => {
	useToolsStore.getState().reset();
	useUiStore.setState({ toolsExpandAll: { expanded: false, seq: 0 } });
	vi.restoreAllMocks();
});

describe("ToolCard terminal states", () => {
	it("marks a call that never returned as interrupted instead of running", async () => {
		useToolsStore.getState().hydrateMessages([call("dead")]);
		useUiStore.getState().toggleToolsExpandAll();
		const { root, container } = await renderCards(["dead"]);

		expect(container.innerHTML).toContain('data-tool-status="aborted"');
		expect(container.innerHTML).not.toContain("animate-spin");
		expect(container.innerHTML).toContain("Interrupted");
		// The specialized read renderer would claim "No content" for a result
		// that never arrived.
		expect(container.innerHTML).not.toContain("No content");

		await act(async () => root.unmount());
	});

	it("shares a single clock between live cards and keeps none for finished ones", async () => {
		useToolsStore.getState().hydrateMessages([call("dead")]);
		useToolsStore.getState().applyEvents([
			{ type: "tool_execution_start", toolCallId: "live-a", toolName: "read", args: {} },
			{ type: "tool_execution_start", toolCallId: "live-b", toolName: "read", args: {} },
		]);
		const ticker = vi.spyOn(globalThis, "setInterval");

		const finished = await renderCards(["dead"]);
		expect(ticker).not.toHaveBeenCalled();
		await act(async () => finished.root.unmount());

		const oneLive = await renderCards(["live-a"]);
		expect(ticker).toHaveBeenCalledTimes(1);

		const twoLive = await renderCards(["live-a", "live-b"]);
		expect(twoLive.container.innerHTML.match(/animate-spin/g)).toHaveLength(2);
		expect(ticker).toHaveBeenCalledTimes(1);

		await act(async () => {
			oneLive.root.unmount();
			twoLive.root.unmount();
		});
		// Every subscriber released it, so the next live card starts a fresh one.
		const relive = await renderCards(["live-a"]);
		expect(ticker).toHaveBeenCalledTimes(2);
		await act(async () => relive.root.unmount());
		ticker.mockRestore();
	});
});

/** A finished call as stock records it: the call (with its wire intent) and its result. */
function finished(
	id: string,
	name: string,
	args: Record<string, unknown>,
	intent?: string,
	details?: Record<string, unknown>,
): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: args, ...(intent ? { intent } : {}) }],
			timestamp: 1_000,
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: "ok" }],
			...(details ? { details } : {}),
			isError: false,
			timestamp: 2_000,
		} as unknown as AgentMessage,
	];
}

/** The row's accessible name: its text and labelled images, without what is hidden from assistive tech. */
function accessibleName(node: Element): string {
	if (node.getAttribute("aria-hidden") === "true") return "";
	if (node.getAttribute("role") === "img") return node.getAttribute("aria-label") ?? "";
	return [...node.childNodes]
		.map(child => (child.nodeType === 3 ? (child.textContent ?? "") : accessibleName(child as Element)))
		.join(" ");
}

async function renderRow(
	messages: AgentMessage[],
	name: string,
	args: Record<string, unknown>,
	props: { showIntent?: boolean } = {},
): Promise<{ root: Root; row: HTMLElement }> {
	useToolsStore.getState().hydrateMessages(messages);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ToolCard args={args} toolCallId="c" toolName={name} {...props} />
			</I18nProvider>,
		);
	});
	return { root, row: container.querySelector("button") as unknown as HTMLElement };
}

const words = (text: string) => text.replace(/\s+/g, " ").trim();

describe("ToolCard rows by intent", () => {
	it.each([
		["bash", { command: "bun run check:types" }, "Checking the types", "bun run check:types", "Run command"],
		["edit", { path: "src/app/main.ts", edits: [] }, "Fixing the import", "main.ts", "Edit"],
		["read", { path: "src/app/main.ts" }, "Reading the entry point", "main.ts", "Read"],
		[
			"eval",
			{ language: "py", title: "Montage", code: "print(1)" },
			"Montaging captures side by side",
			"Montage",
			"Run",
		],
	])(
		"leads a %s row with its intent, the target after it, the tool label gone",
		async (name, args, intent, target, label) => {
			const { root, row } = await renderRow(finished("c", name, args, intent), name, args);
			const text = words(row.textContent ?? "");
			expect(text.startsWith(intent)).toBe(true);
			expect(text.indexOf(target)).toBeGreaterThan(intent.length - 1);
			expect(text.slice(intent.length)).not.toContain(label);
			const spoken = words(accessibleName(row));
			expect(spoken).toContain(intent);
			expect(spoken).toContain(target);
			expect(spoken).toContain("Done");
			await act(async () => root.unmount());
		},
	);

	it("says a subagent's intent once when its target only restates it", async () => {
		const args = { i: "Reviewing the diff", agent: "reviewer", tasks: [] };
		const { root, row } = await renderRow(finished("c", "task", args), "task", args);
		expect(words(row.textContent ?? "").split("Reviewing the diff")).toHaveLength(2);
		await act(async () => root.unmount());
	});

	it("keeps the tool's label and target for a call with no intent, a generic one, or under a row that says it", async () => {
		const args = { command: "ls -la" };
		for (const [intent, props] of [
			[undefined, {}],
			["Running requested command", {}],
			["Listing files", { showIntent: false }],
		] as const) {
			useToolsStore.getState().reset();
			const { root, row } = await renderRow(finished("c", "bash", args, intent), "bash", args, props);
			const text = words(row.textContent ?? "");
			expect(text.startsWith("Run command")).toBe(true);
			expect(text).toContain("ls -la");
			expect(text).not.toContain("Listing files");
			await act(async () => root.unmount());
		}
	});
});

describe("ToolCard opened bodies", () => {
	const count = (text: string, part: string) => text.split(part).length - 1;

	it.each([
		["edit", { path: "src/app/main.ts", edits: [] }, { diff: "@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n" }],
		["read", { path: "src/app/main.ts" }, undefined],
	])(
		"names an opened %s step's file and line counts once, and keeps a link that opens it",
		async (name, args, details) => {
			const { root, row } = await renderRow(finished("c", name, args, "Fixing the import", details), name, args);
			await act(async () => row.dispatchEvent(new Event("click", { bubbles: true }) as never));
			const card = row.parentElement as HTMLElement;
			expect(card.querySelector(".omp-tool-body")).not.toBeNull();
			expect(count(card.textContent ?? "", "main.ts")).toBe(1);
			expect(count(card.textContent ?? "", "src/app")).toBe(1);
			if (details) expect(card.querySelectorAll(".omp-tool-diffstat")).toHaveLength(1);
			const open = card.querySelector(".omp-tool-body .omp-tool-open-file");
			expect(open?.textContent).toBe("Open file");
			expect(open?.getAttribute("title")).toBe("src/app/main.ts");
			await act(async () => root.unmount());
		},
	);
});
