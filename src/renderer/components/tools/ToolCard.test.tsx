import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

/** Text a sighted reader sees: screen-reader-only words left out. */
const visible = (node: Element | null): string =>
	node
		? [...node.childNodes]
				.map(child =>
					child.nodeType === 3
						? (child.textContent ?? "")
						: (child as Element).classList.contains("sr-only")
							? ""
							: visible(child as Element),
				)
				.join("")
		: "";

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
			"Run Python",
		],
	])(
		"leads a %s row with its intent, the target after it; a screen reader hears its kind first and its state last",
		async (name, args, intent, target, label) => {
			const { root, row } = await renderRow(finished("c", name, args, intent), name, args);
			const text = words(visible(row));
			expect(text.startsWith(intent)).toBe(true);
			expect(text.indexOf(target)).toBeGreaterThan(intent.length - 1);
			expect(text.slice(intent.length)).not.toContain(label);
			const spoken = words(accessibleName(row));
			expect(spoken.startsWith(`${label}, ${intent}`)).toBe(true);
			expect(spoken.indexOf("Done")).toBeGreaterThan(spoken.indexOf(target));
			await act(async () => root.unmount());
		},
	);

	it.each([
		["task", { i: "Reviewing the diff", agent: "reviewer", tasks: [] }, "Subagent"],
		["wait", { i: "Waiting for the build" }, "Wait"],
	])("keeps the kind of a %s row whose target only restates its intent", async (name, args, label) => {
		const { root, row } = await renderRow(finished("c", name, args), name, args);
		const spoken = words(accessibleName(row));
		expect(spoken).toContain(label);
		expect(spoken).toContain(args.i);
		await act(async () => root.unmount());
	});

	it("says an intent once when its target only restates it, whole or cut short", async () => {
		const long = `Reviewing the diff ${"and every file it touches ".repeat(8)}`.trim();
		for (const [name, args] of [
			["task", { i: "Reviewing the diff", agent: "reviewer", tasks: [] }],
			["wait", { i: long }],
			["wait", { i: "Waiting for the build\nthen the tests" }],
		] as const) {
			useToolsStore.getState().reset();
			const { root, row } = await renderRow(finished("c", name, args), name, args);
			expect(words(visible(row)).split("Reviewing the diff").length).toBeLessThanOrEqual(2);
			expect(words(visible(row)).split("Waiting for the build").length).toBeLessThanOrEqual(2);
			await act(async () => root.unmount());
		}
	});

	it.each([
		[{}, ""],
		[{ query: "flaky sidebar" }, "flaky sidebar"],
	])("keeps an MCP tool's name on the row after the intent, with or without a target (%o)", async (args, target) => {
		const { root, row } = await renderRow(
			finished("c", "mcp__github_search_issues", args, "Finding the bug report"),
			"mcp__github_search_issues",
			args,
		);
		const text = words(visible(row));
		expect(text.startsWith("Finding the bug report")).toBe(true);
		expect(text).toContain("github · search_issues");
		if (target) expect(text.indexOf(target)).toBeGreaterThan(text.indexOf("github · search_issues"));
		// Said once: the visible name is not repeated to a screen reader.
		expect(words(accessibleName(row)).split("github · search_issues")).toHaveLength(2);
		await act(async () => root.unmount());
	});

	it("keeps a device's name on the row after the intent", async () => {
		const args = { path: "xd://lsp", content: JSON.stringify({ action: "references", symbol: "groupSteps" }) };
		const { root, row } = await renderRow(finished("c", "write", args, "Finding every caller"), "write", args);
		const text = words(visible(row));
		expect(text.startsWith("Finding every caller")).toBe(true);
		expect(text).toContain("Code intelligence");
		expect(text).toContain("references groupSteps");
		await act(async () => root.unmount());
	});

	it("says every state with the visible words' casing", async () => {
		useToolsStore.getState().applyEvents([
			{
				type: "tool_execution_start",
				toolCallId: "c",
				toolName: "bash",
				args: { command: "ls" },
				intent: "Listing",
			},
		]);
		const { root, row } = await renderRow([], "bash", { command: "ls" });
		expect(words(accessibleName(row))).toContain("Running");
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
			const text = words(visible(row));
			expect(text.startsWith("Run command")).toBe(true);
			expect(text).toContain("ls -la");
			expect(text).not.toContain("Listing files");
			await act(async () => root.unmount());
		}
	});
});

describe("ToolCard opened bodies", () => {
	/** What the row's target measures: the width it has and the width its text needs. */
	const layout = { client: 200, scroll: 120 };
	/**
	 * Every ResizeObserver made, with what it watches. `resize()` is a change of the targets' own boxes while each row
	 * keeps its width: it reaches only observers that watch a target, as a real one would.
	 */
	const observers: Array<{ callback: (entries: Array<{ target: Element }>) => void; targets: Set<Element> }> = [];
	const resize = () =>
		act(async () => {
			for (const { callback, targets } of observers) {
				const boxes = [...targets].filter(target => target.classList.contains("omp-tool-summary"));
				if (boxes.length > 0) callback(boxes.map(target => ({ target })));
			}
		});
	const proto = HTMLElement.prototype as object;
	beforeAll(() => {
		for (const [key, field] of [
			["clientWidth", "client"],
			["scrollWidth", "scroll"],
		] as const) {
			Object.defineProperty(proto, key, {
				configurable: true,
				get(this: Element) {
					return this.classList?.contains("omp-tool-summary") ? layout[field] : 0;
				},
			});
		}
		globals.ResizeObserver = class {
			#watch: (typeof observers)[number];
			constructor(callback: (typeof observers)[number]["callback"]) {
				this.#watch = { callback, targets: new Set() };
				observers.push(this.#watch);
			}
			observe(target: Element) {
				this.#watch.targets.add(target);
				// A real observer reports a newly observed element once.
				const { callback } = this.#watch;
				queueMicrotask(() => callback([{ target }]));
			}
			unobserve(target: Element) {
				this.#watch.targets.delete(target);
			}
			disconnect() {
				this.#watch.targets.clear();
			}
		};
	});
	afterAll(() => {
		Reflect.deleteProperty(proto, "clientWidth");
		Reflect.deleteProperty(proto, "scrollWidth");
		delete globals.ResizeObserver;
	});
	afterEach(() => {
		Object.assign(layout, { client: 200, scroll: 120 });
	});

	const count = (text: string, part: string) => text.split(part).length - 1;
	const open = async (row: HTMLElement) =>
		act(async () => row.dispatchEvent(new Event("click", { bubbles: true }) as never));
	const edit = { path: "src/app/main.ts", edits: [] };
	const editResult = { diff: "@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n", firstChangedLine: 3 };

	it.each([
		["edit", edit, editResult],
		["read", { path: "src/app/main.ts" }, undefined],
	])(
		"names an opened %s step's file and line counts once, and keeps a link that opens it",
		async (name, args, details) => {
			const { root, row } = await renderRow(finished("c", name, args, "Fixing the import", details), name, args);
			await open(row);
			const card = row.parentElement as HTMLElement;
			expect(card.querySelector(".omp-tool-body")).not.toBeNull();
			expect(count(visible(card), "main.ts")).toBe(1);
			expect(count(visible(card), "src/app")).toBe(1);
			if (details) expect(card.querySelectorAll(".omp-tool-diffstat")).toHaveLength(1);
			const link = card.querySelector(".omp-tool-body .omp-tool-open-file");
			expect(visible(link)).toBe("Open file");
			expect(words(link?.textContent ?? "")).toBe("Open file main.ts");
			expect(link?.getAttribute("title")).toBe("src/app/main.ts");
			await act(async () => root.unmount());
		},
	);

	it("keeps an edit's first changed line beside the link", async () => {
		const { root, row } = await renderRow(finished("c", "edit", edit, "Fixing the import", editResult), "edit", edit);
		await open(row);
		expect(visible(row.parentElement?.querySelector(".omp-tool-edit-heading") ?? null)).toBe("Open file:3");
		await act(async () => root.unmount());
	});

	it("names the file in the body while the row cannot show it, and again after the row narrows", async () => {
		layout.client = 0;
		const { root, row } = await renderRow(finished("c", "edit", edit, "Fixing the import", editResult), "edit", edit);
		await open(row);
		const body = () => row.parentElement?.querySelector(".omp-tool-body") ?? null;
		expect(visible(body())).toContain("main.ts");
		expect(body()?.querySelector(".omp-tool-open-file")).toBeNull();
		// The row widens: the body stops repeating the path; it narrows again: the path comes back.
		Object.assign(layout, { client: 200, scroll: 120 });
		await resize();
		expect(body()?.querySelector(".omp-tool-open-file")).not.toBeNull();
		Object.assign(layout, { client: 80, scroll: 120 });
		await resize();
		expect(visible(body())).toContain("main.ts");
		expect(body()?.querySelector(".omp-tool-open-file")).toBeNull();
		await act(async () => root.unmount());
	});

	it("offers no file to open for a URL the row shows", async () => {
		const args = { path: "https://example.com/report" };
		const { root, row } = await renderRow(finished("c", "read", args, "Reading the report"), "read", args);
		await open(row);
		const card = row.parentElement as HTMLElement;
		expect(card.querySelector(".omp-tool-open-file")).toBeNull();
		expect(count(visible(card), "example.com")).toBe(1);
		await act(async () => root.unmount());
	});

	it("draws no sliver of a target the row squeezes to a few pixels, and draws it again when there is room", async () => {
		const args = { command: "grep -rn needle src" };
		const { root, row } = await renderRow(finished("c", "bash", args, "Finding the needle"), "bash", args);
		const target = () => row.querySelector(".omp-tool-summary");
		Object.assign(layout, { client: 8, scroll: 150 });
		await resize();
		expect(target()?.hasAttribute("data-sliver")).toBe(true);
		// Still read aloud: only drawing stops.
		expect(words(accessibleName(row))).toContain("grep -rn needle src");
		Object.assign(layout, { client: 200, scroll: 150 });
		await resize();
		expect(target()?.hasAttribute("data-sliver")).toBe(false);
		// A short target that fits whole in little room is no sliver.
		Object.assign(layout, { client: 16, scroll: 16 });
		await resize();
		expect(target()?.hasAttribute("data-sliver")).toBe(false);
		await act(async () => root.unmount());
	});

	it("measures the target again when its text changes inside a row that keeps its width", async () => {
		const before = { command: "ls" };
		const after = { command: "grep -rn needle src/renderer/components" };
		const { root, row } = await renderRow(finished("c", "bash", before, "Looking around"), "bash", before);
		await open(row);
		const body = () => row.parentElement?.querySelector(".omp-tool-body") ?? null;
		expect(body()?.querySelector(".omp-bash-prompt")).toBeNull();
		// The new command no longer fits, and nothing about the row's own box changes.
		Object.assign(layout, { client: 8, scroll: 150 });
		await act(async () => {
			root.render(
				<I18nProvider>
					<ToolCard args={after} toolCallId="c" toolName="bash" />
				</I18nProvider>,
			);
		});
		expect(body()?.querySelector(".omp-bash-prompt")?.textContent).toContain(after.command);
		expect(row.querySelector(".omp-tool-summary")?.hasAttribute("data-sliver")).toBe(true);
		await act(async () => root.unmount());
	});
});
