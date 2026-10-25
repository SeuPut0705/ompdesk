import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage, MessageContent, ToolCallContent } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../../stores/tools";
import { useUiStore } from "../../../stores/ui";
import type { StepReveal } from "./reveal-step";

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
Object.assign(window, { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });

// React DOM must initialize after linkedom globals; static imports initialize it too early.
const { createRoot } = await import("react-dom/client");
const { StepGroups } = await import("./StepGroups");
const { StepRevealContext } = await import("./reveal-step");
const { createStageCall, StageCallContext } = await import("../LiveStepPeek");

let container: HTMLElement;
let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	useToolsStore.getState().reset();
	useUiStore.setState({ displayPreferences: {} });
});

function call(id: string, name: string, args: Record<string, unknown>, intent?: string): ToolCallContent {
	return { type: "toolCall", id, name, arguments: args, ...(intent ? { intent } : {}) };
}

function entry(name: string, args: Record<string, unknown>, status: ToolEntry["status"] = "done"): ToolEntry {
	return {
		toolName: name,
		args,
		status,
		streamingArgs: "",
		result: { content: [{ type: "text", text: "out" }] },
		isError: status === "error",
		startTime: 1,
		endTime: 2,
	};
}

let clock = 0;
const assistant = (content: MessageContent[]): AgentMessage =>
	({ role: "assistant", content, timestamp: ++clock }) as AgentMessage;

async function mount(messages: AgentMessage[], entries: [string, ToolEntry][], reveal: StepReveal | null = null) {
	useToolsStore.setState(toolEntriesState(entries));
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<StepRevealContext.Provider value={reveal}>
					<StepGroups messages={messages} />
				</StepRevealContext.Provider>
			</I18nProvider>,
		),
	);
}

const groups = () => [...container.querySelectorAll("[data-step-group]")] as unknown as HTMLElement[];
const cards = () =>
	[...container.querySelectorAll("[data-tool-call-id]")].map(card => card.getAttribute("data-tool-call-id"));
const toggle = (group: HTMLElement | undefined) =>
	act(async () => group?.querySelector("button")?.dispatchEvent(new Event("click", { bubbles: true }) as never));

const bash = (command: string, status: ToolEntry["status"] = "done") => entry("bash", { command }, status);

describe("StepGroups", () => {
	it("lines same-intent calls up under one closed row that counts them, and opens to every call's own card", async () => {
		await mount(
			[
				assistant([
					call("a", "bash", { command: "bun run check:types" }, "Checking the types"),
					call("b", "bash", { command: "bun run check:types" }, "Checking the types"),
					call("c", "edit", { path: "src/a.ts" }, "Fixing the type"),
				]),
			],
			[
				["a", bash("bun run check:types")],
				["b", bash("bun run check:types")],
				["c", entry("edit", { path: "src/a.ts" })],
			],
		);
		expect(groups()).toHaveLength(1);
		expect(groups()[0]?.querySelector(".omp-step-group-label")?.textContent).toBe("Checking the types");
		expect(groups()[0]?.textContent).toContain("2 steps");
		expect(groups()[0]?.getAttribute("data-open")).toBe("false");
		expect(cards()).toEqual(["c"]);
		await toggle(groups()[0]);
		expect(groups()[0]?.getAttribute("data-open")).toBe("true");
		expect(cards()).toEqual(["a", "b", "c"]);
	});

	it("opens a group by itself when one of its calls failed", async () => {
		await mount(
			[
				assistant([
					call("a", "bash", { command: "x" }, "Running the tests"),
					call("b", "bash", { command: "x" }, "Running the tests"),
				]),
			],
			[
				["a", bash("x")],
				["b", bash("x", "error")],
			],
		);
		expect(groups()[0]?.getAttribute("data-open")).toBe("true");
		expect(groups()[0]?.getAttribute("data-state")).toBe("error");
		expect(cards()).toEqual(["a", "b"]);
	});

	it("opens the group holding the step a finding asks for, again after the reader closed it", async () => {
		const messages = [
			assistant([call("a", "bash", { command: "x" }, "Same"), call("b", "bash", { command: "x" }, "Same")]),
		];
		const entries: [string, ToolEntry][] = [
			["a", bash("x")],
			["b", bash("x")],
		];
		await mount(messages, entries, { key: "b" });
		expect(groups()[0]?.getAttribute("data-open")).toBe("true");
		await toggle(groups()[0]);
		expect(groups()[0]?.getAttribute("data-open")).toBe("false");
		await act(async () =>
			root?.render(
				<I18nProvider>
					<StepRevealContext.Provider value={{ key: "b" }}>
						<StepGroups messages={messages} />
					</StepRevealContext.Provider>
				</I18nProvider>,
			),
		);
		expect(groups()[0]?.getAttribute("data-open")).toBe("true");
	});

	it("folds consecutive reads into the read group card, one row for the reader", async () => {
		await mount(
			[
				assistant([
					call("r1", "read", { path: "a.ts", __ompReadGroup: { path: "a.ts" } }),
					call("r2", "read", { path: "b.ts", __ompReadGroup: { path: "b.ts" } }),
					call("g", "grep", { pattern: "x" }),
				]),
			],
			[
				["r1", entry("read", { path: "a.ts" })],
				["r2", entry("read", { path: "b.ts" })],
				["g", entry("grep", { pattern: "x" })],
			],
		);
		expect(container.querySelectorAll(".omp-read-group")).toHaveLength(1);
		expect(container.querySelector(".omp-read-group")?.textContent).toContain("a.ts, b.ts");
		expect(cards()).toEqual(["g"]);
	});

	it("opens a folded read group holding a failed read", async () => {
		await mount(
			[
				assistant([
					call("r1", "read", { path: "a.ts", __ompReadGroup: { path: "a.ts" } }),
					call("r2", "read", { path: "b.ts", __ompReadGroup: { path: "b.ts" } }),
				]),
			],
			[
				["r1", entry("read", { path: "a.ts" })],
				["r2", entry("read", { path: "b.ts" }, "error")],
			],
		);
		expect(cards()).toEqual(["r1", "r2"]);
	});

	it("leaves a card with no repeated intent exactly as the messages hold it", async () => {
		await mount(
			[
				assistant([{ type: "text", text: "Looking." }, call("a", "grep", { pattern: "x" }, "Searching")]),
				assistant([call("b", "bash", { command: "ls" }, "Listing")]),
			],
			[
				["a", entry("grep", { pattern: "x" })],
				["b", bash("ls")],
			],
		);
		expect(groups()).toHaveLength(0);
		expect(container.textContent).toContain("Looking.");
		expect(cards()).toEqual(["a", "b"]);
	});

	it("folds the thoughts before a step into its row as a count, shows them first when it opens, and keeps a trailing run one row", async () => {
		const think = (text: string) => assistant([{ type: "thinking", thinking: text }]);
		await mount(
			[
				think("First idea"),
				assistant([{ type: "thinking", thinking: "Second idea" }, call("a", "bash", { command: "ls" }, "Listing")]),
				think("Wrapping up"),
				think("Really done"),
			],
			[["a", { ...bash("ls"), intent: "Listing" }]],
		);
		const card = container.querySelector("[data-tool-call-id='a']");
		const header = card?.querySelector("button");
		expect(header?.textContent).toContain("Listing");
		expect(header?.textContent).toContain("2 thoughts");
		expect(container.querySelectorAll(".omp-thinking-block")).toHaveLength(1);
		await act(async () => header?.dispatchEvent(new Event("click", { bubbles: true }) as never));
		const body = card?.querySelector(".omp-tool-body");
		expect(body?.firstElementChild?.querySelectorAll(".omp-thinking-block")).toHaveLength(2);
		expect(body?.querySelector(".omp-bash-terminal")).not.toBeNull();
	});

	it("still opens a failed group by itself when thoughts folded into its row", async () => {
		await mount(
			[
				assistant([{ type: "thinking", thinking: "Try the suite" }]),
				assistant([
					call("a", "bash", { command: "x" }, "Running the tests"),
					call("b", "bash", { command: "x" }, "Running the tests"),
				]),
			],
			[
				["a", bash("x")],
				["b", bash("x", "error")],
			],
		);
		expect(groups()).toHaveLength(1);
		expect(groups()[0]?.getAttribute("data-open")).toBe("true");
		expect(groups()[0]?.querySelector("button")?.textContent).toContain("1 thought");
		expect(cards()).toEqual(["a", "b"]);
	});

	describe("append-only (a running card)", () => {
		const stage = createStageCall();
		async function show(messages: AgentMessage[], appendOnly: boolean) {
			if (!root) {
				container = document.createElement("div") as unknown as HTMLElement;
				document.body.appendChild(container as never);
				root = createRoot(container as unknown as Element);
			}
			await act(async () =>
				root?.render(
					<I18nProvider>
						<StageCallContext.Provider value={stage}>
							<StepGroups appendOnly={appendOnly} messages={messages} />
						</StageCallContext.Provider>
					</I18nProvider>,
				),
			);
		}
		const rows = () => [...container.children];
		const step = (index: number): AgentMessage[] => [
			assistant([
				call(
					`c${index}`,
					"bash",
					{ command: `step ${index}` },
					index < 10 ? "Reading the board" : "Checking the types",
				),
			]),
			{
				role: "toolResult",
				toolCallId: `c${index}`,
				toolName: "bash",
				content: [],
				timestamp: ++clock,
			} as AgentMessage,
		];
		afterEach(() => stage.setState({ key: null }));

		it("streams 20 calls of two intents and keeps every row it showed, in place, through the finish", async () => {
			const entries: [string, ToolEntry][] = [];
			const messages: AgentMessage[] = [];
			let seen: Element[] = [];
			for (let index = 0; index < 20; index++) {
				if (index > 0) entries[index - 1] = [`c${index - 1}`, bash(`step ${index - 1}`)];
				entries.push([`c${index}`, bash(`step ${index}`, "running")]);
				act(() => useToolsStore.setState(toolEntriesState(entries)));
				messages.push(...step(index));
				await show([...messages], true);
				const now = rows();
				expect(now.slice(0, seen.length)).toEqual(seen);
				expect(now.length).toBe(seen.length + 1);
				seen = now;
			}
			act(() => useToolsStore.setState(toolEntriesState(entries.map(([id]) => [id, bash(id)]))));
			await show([...messages], false);
			expect(rows()).toEqual(seen);
			expect(cards()).toEqual(Array.from({ length: 20 }, (_, index) => `c${index}`));
			expect(groups()).toHaveLength(0);
		});

		it("a list mounted on the finished messages (a reload) lines the same calls up by intent", async () => {
			act(() =>
				useToolsStore.setState(
					toolEntriesState(Array.from({ length: 20 }, (_, index) => [`c${index}`, bash(`step ${index}`)])),
				),
			);
			await show(Array.from({ length: 20 }, (_, index) => step(index)).flat(), false);
			expect(groups().map(group => group.querySelector(".omp-step-group-label")?.textContent)).toEqual([
				"Reading the board",
				"Checking the types",
			]);
		});

		it("groups same-intent calls that arrive together, and never pulls a later call into a shown row", async () => {
			const together = assistant([
				call("a", "bash", { command: "a" }, "Reading the board"),
				call("b", "bash", { command: "b" }, "Reading the board"),
			]);
			act(() =>
				useToolsStore.setState(
					toolEntriesState([
						["a", bash("a")],
						["b", bash("b")],
						["c", bash("c")],
					]),
				),
			);
			await show([together], true);
			expect(groups()).toHaveLength(1);
			const group = groups()[0];
			await show([together, assistant([call("c", "bash", { command: "c" }, "Reading the board")])], true);
			expect(groups()).toEqual([group]);
			expect(group?.querySelector("button")?.textContent).toContain("2 steps");
			expect(rows()).toHaveLength(2);
		});

		it("leaves off its last row while the live stage shows that call running, then lists it there", async () => {
			act(() =>
				useToolsStore.setState(
					toolEntriesState([
						["c9", bash("step 9")],
						["c10", bash("step 10", "running")],
					]),
				),
			);
			const messages = [...step(9), ...step(10)];
			act(() => stage.setState({ key: "c10" }));
			await show(messages, true);
			expect(cards()).toEqual(["c9"]);
			const first = rows()[0];
			act(() => stage.setState({ key: null }));
			await show(messages, true);
			expect(cards()).toEqual(["c9", "c10"]);
			expect(rows()[0]).toBe(first);
		});
	});
});

describe("StepGroups, review fixes", () => {
	const think = (text: string) => assistant([{ type: "thinking", thinking: text }]);
	const open = (button: Element | null | undefined) =>
		act(async () => button?.dispatchEvent(new Event("click", { bubbles: true }) as never));

	it("neither counts nor opens to thoughts while thinking is hidden", async () => {
		useUiStore.setState({ displayPreferences: { hideThinkingBlock: true } });
		await mount(
			[
				think("First idea"),
				assistant([call("a", "bash", { command: "ls" }, "Listing")]),
				think("Group idea"),
				assistant([call("b", "bash", { command: "x" }, "Same"), call("c", "bash", { command: "x" }, "Same")]),
			],
			[
				["a", bash("ls")],
				["b", bash("x")],
				["c", bash("x")],
			],
		);
		expect(container.textContent).not.toContain("thought");
		await open(container.querySelector("[data-tool-call-id='a'] button"));
		await open(groups()[0]?.querySelector("button"));
		expect(container.querySelectorAll(".omp-step-thoughts-body")).toHaveLength(0);
	});

	it("lets the reads inside an intent group lead with their tool, as the group's other calls do", async () => {
		const read = (path: string) => ({ ...entry("read", { path }), intent: "Looking around" });
		await mount(
			[
				assistant([
					call("r1", "read", { path: "a.ts", __ompReadGroup: { path: "a.ts" } }, "Looking around"),
					call("r2", "read", { path: "b.ts", __ompReadGroup: { path: "b.ts" } }, "Looking around"),
					call("g", "grep", { pattern: "x" }, "Looking around"),
				]),
			],
			[
				["r1", read("a.ts")],
				["r2", read("b.ts")],
				["g", { ...entry("grep", { pattern: "x" }), intent: "Looking around" }],
			],
		);
		await open(groups()[0]?.querySelector("button"));
		await open(container.querySelector(".omp-read-group-header"));
		const body = container.querySelector(".omp-step-group-body");
		expect(body?.textContent).not.toContain("Looking around");
		expect([...(body?.querySelectorAll(".omp-tool-name") ?? [])].map(node => node.textContent)).toEqual([
			"Read",
			"Read",
			"Search",
		]);
	});

	it("says in words that a group's calls were interrupted or still run", async () => {
		await mount(
			[assistant([call("a", "bash", { command: "x" }, "Same"), call("b", "bash", { command: "x" }, "Same")])],
			[
				["a", bash("x")],
				["b", bash("x", "aborted")],
			],
		);
		expect(groups()[0]?.querySelector("button")?.textContent).toContain("Interrupted");
		useToolsStore.setState(toolEntriesState([["b", bash("x", "running")]]));
		await act(async () => {});
		expect(groups()[0]?.querySelector("button")?.textContent).toContain("Running");
	});
});
