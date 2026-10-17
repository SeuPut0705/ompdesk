/**
 * The side panel's Subagent view: one-line header (name and model mark, status, tokens, clock, open/stop/copy),
 * and a transcript drawn by the main transcript's own components (editorial turns, markdown, work card or
 * tool cards by the transcript-detail switch) in a runtime of its own, so the owning tab's streams never bleed
 * in, a running agent's trailing call reads as running, and a poll with nothing new re-renders no row.
 */
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AgentMessage, RpcCommand, SubagentSnapshot } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { preloadMarkdownPipeline } from "../../lib/markdown";
import type { MessagesStore } from "../../stores/messages";
import { deleteSessionRuntime, sessionRuntimeStore } from "../../stores/session-runtime-context";
import type { SubagentsStore } from "../../stores/subagents";
import { ensureTabRuntime } from "../../stores/tab-runtime";
import { useUiStore } from "../../stores/ui";
import { transcriptToText } from "./subagent-transcript-text";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
(window as unknown as Record<string, unknown>).setTimeout = setTimeout;
(window as unknown as Record<string, unknown>).clearTimeout = clearTimeout;
(window as unknown as Record<string, unknown>).setInterval = setInterval;
(window as unknown as Record<string, unknown>).clearInterval = clearInterval;

// Deferred until after the globals above: react-dom computes DOM support flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { SubagentPanel } = await import("./SubagentPanel");

const TAB = "sv1";

interface TestElement {
	textContent: string | null;
	className: string;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => ArrayLike<TestElement>;
	remove: () => void;
}

let commandForTab: Mock<(tabId: string, command: RpcCommand) => Promise<unknown>>;
let pages: AgentMessage[];
let container: TestElement;
let root: Root | undefined;

const NOW = Date.now();

function snap(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return {
		id: "r1",
		index: 1,
		agent: "explore",
		description: "Map the settings code",
		status: "running",
		lastUpdate: NOW,
		sessionFile: "/tmp/r1.jsonl",
		progress: {
			index: 1,
			id: "r1",
			agent: "explore",
			agentSource: "bundled",
			status: "running",
			task: "Map the settings code",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			requests: 2,
			tokens: 48_200,
			cost: 0,
			durationMs: 92_000,
			resolvedModel: "anthropic/claude-sonnet-4-5",
		},
		...overrides,
	};
}

const DIFF = [
	"@@ -1,2 +1,3 @@",
	" export function load() {",
	"-  return raw;",
	"+  const parsed = parse(raw);",
	"+  return parsed;",
	" }",
].join("\n");

/** A run: the assignment, thinking and a read, a bash, an edit, a markdown reply with code, a bash still going. */
function run(): AgentMessage[] {
	let stamp = NOW - 60_000;
	const next = () => stamp++ * 1000;
	return [
		{ role: "user", timestamp: next(), content: [{ type: "text", text: "Map the settings code" }] },
		{
			role: "assistant",
			timestamp: next(),
			content: [
				{ type: "thinking", thinking: "Start from the reader." },
				{ type: "toolCall", id: "c-read", name: "read", arguments: { path: "src/main/settings.ts" } },
			],
		},
		{
			role: "toolResult",
			toolCallId: "c-read",
			toolName: "read",
			content: [{ type: "text", text: "export function load() {}" }],
			isError: false,
			timestamp: next(),
		},
		{
			role: "assistant",
			timestamp: next(),
			content: [{ type: "toolCall", id: "c-bash", name: "bash", arguments: { command: "rg -n settings src" } }],
		},
		{
			role: "toolResult",
			toolCallId: "c-bash",
			toolName: "bash",
			content: [{ type: "text", text: "src/main/settings.ts:1" }],
			details: { exitCode: 0 },
			isError: false,
			timestamp: next(),
		},
		{
			role: "assistant",
			timestamp: next(),
			content: [
				{
					type: "toolCall",
					id: "c-edit",
					name: "edit",
					arguments: {
						path: "src/main/settings.ts",
						edits: [{ old_text: "return raw;", new_text: "return parsed;" }],
					},
				},
			],
		},
		{
			role: "toolResult",
			toolCallId: "c-edit",
			toolName: "edit",
			content: [{ type: "text", text: "Updated src/main/settings.ts" }],
			details: { diff: DIFF },
			isError: false,
			timestamp: next(),
		},
		{
			role: "assistant",
			timestamp: next(),
			content: [{ type: "text", text: "## Settings map\n\n```ts\nexport const answer = 42;\n```\n\nThree layers." }],
		},
		{
			role: "assistant",
			timestamp: next(),
			content: [{ type: "toolCall", id: "c-test", name: "bash", arguments: { command: "bun test" } }],
		},
	];
}

function seed(agents: SubagentSnapshot[]): void {
	act(() => sessionRuntimeStore<SubagentsStore>(TAB, "subagents")!.getState().setSnapshots(agents));
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
	for (let round = 0; round < 4; round++) await flush();
}

function view(): TestElement {
	const found = document.querySelector('[data-panel-subagent="r1"]') as unknown as TestElement | null;
	if (!found) throw new Error("the Subagent view is not mounted");
	return found;
}

function all(selector: string): TestElement[] {
	return Array.from(view().querySelectorAll(selector));
}

function fetched(): number {
	return commandForTab.mock.calls.filter(([, command]) => command.type === "get_subagent_messages").length;
}

beforeAll(() => preloadMarkdownPipeline());

beforeEach(() => {
	pages = run();
	commandForTab = vi.fn(async (_tabId: string, command: RpcCommand) => ({
		type: "response",
		command: command.type,
		success: true,
		data: command.type === "get_subagent_messages" ? { messages: pages, nextByte: 0 } : { ok: true },
	}));
	(window as unknown as { omp: unknown }).omp = { rpc: { commandForTab } };
	ensureTabRuntime(TAB);
	useUiStore.setState({ transcriptDetail: "compact" });
});

afterEach(async () => {
	if (root) {
		await act(async () => {
			root?.unmount();
		});
		root = undefined;
	}
	container?.remove();
	document.body.innerHTML = "";
	deleteSessionRuntime(TAB);
});

describe("Subagent view header", () => {
	it("is one row: agent and model mark, then status, tokens, clock, and the open, stop and copy icons", async () => {
		seed([snap()]);
		await mount(<SubagentPanel subagent={{ tabId: TAB, agentId: "r1" }} />);
		const header = view().querySelector(".omp-subagent-header");
		expect(header).not.toBeNull();
		// Left: the model's provider mark, the agent and its task.
		expect(header?.querySelector('[data-provider-mark="anthropic"]')).not.toBeNull();
		expect(header?.textContent).toContain("explore");
		expect(header?.textContent).toContain("Map the settings code");
		// Right: status, tokens, clock.
		const status = header?.querySelector("[data-subagent-status]");
		expect(status?.getAttribute("data-subagent-status")).toBe("running");
		expect(status?.textContent).toContain(translate("subagent.status.started"));
		expect(status?.textContent).toContain("48.2k");
		expect(status?.textContent).toMatch(/1m 3\ds|1m 3\d|1m 4\d/);
		// Icons: every one a labelled button.
		const labels = Array.from(header?.querySelectorAll("button") ?? []).map(button =>
			button.getAttribute("aria-label"),
		);
		expect(labels).toEqual([
			translate("panel.subagent.openFull"),
			translate("sidebar.subagents.stop"),
			translate("panel.subagent.copy"),
		]);
	});

	it("offers no stop for a finished agent or an advisor", async () => {
		seed([snap({ status: "completed" })]);
		await mount(<SubagentPanel subagent={{ tabId: TAB, agentId: "r1" }} />);
		const labels = Array.from(view().querySelectorAll(".omp-subagent-header button")).map(button =>
			button.getAttribute("aria-label"),
		);
		expect(labels).not.toContain(translate("sidebar.subagents.stop"));
		expect(view().querySelector("[data-subagent-steer]")).toBeNull();
	});
});

describe("Subagent view transcript", () => {
	it("draws the main transcript's own turns: the assignment bubble, markdown with code, and one work card", async () => {
		seed([snap()]);
		await mount(<SubagentPanel subagent={{ tabId: TAB, agentId: "r1" }} />);
		expect(view().querySelector(".omp-transcript-editorial.omp-subagent-conversation")).not.toBeNull();
		expect(view().querySelector(".omp-user-bubble")?.textContent).toContain("Map the settings code");
		const reply = view().querySelector(".markdown-body h2");
		expect(reply?.textContent).toContain("Settings map");
		expect(view().querySelector(".markdown-body pre code")?.textContent).toContain("answer = 42");
		// Compact detail folds the reads, bash and edit into the work card; the trailing bash is running.
		const cards = all(".omp-execution-group");
		expect(cards.length).toBeGreaterThan(0);
		expect(cards.at(-1)?.getAttribute("data-state")).toBe("running");
	});

	it("shows the same tool cards as the main transcript in full detail, with the edit's diff stats and a running call", async () => {
		useUiStore.setState({ transcriptDetail: "full" });
		seed([snap()]);
		await mount(<SubagentPanel subagent={{ tabId: TAB, agentId: "r1" }} />);
		const headers = all(".omp-tool-header").map(node => node.textContent ?? "");
		expect(headers.some(text => text.includes("Read") && text.includes("settings.ts"))).toBe(true);
		expect(headers.some(text => text.includes("rg -n settings src"))).toBe(true);
		expect(headers.some(text => text.includes("+2") && text.includes("1"))).toBe(true);
		// The call nothing answered yet while the agent runs is a live one, not an aborted one.
		const last = headers.at(-1) ?? "";
		expect(last).toContain("bun test");
		expect(view().textContent).not.toContain(translate("chat.process.interrupted"));
	});

	it("keeps the owning tab's own stream out of the cards", async () => {
		seed([snap()]);
		const owner = sessionRuntimeStore<MessagesStore>(TAB, "messages")!;
		act(() =>
			owner.setState({
				streamingMessage: { role: "assistant", content: [], timestamp: NOW },
				streamingText: "OWNER-STREAMING-TEXT",
				streamingThinking: "OWNER-THINKING",
			}),
		);
		await mount(<SubagentPanel subagent={{ tabId: TAB, agentId: "r1" }} />);
		expect(view().textContent).not.toContain("OWNER-STREAMING-TEXT");
		expect(view().textContent).not.toContain("OWNER-THINKING");
	});

	it("follows a running agent: a progress frame fetches only what is new and no row is replaced", async () => {
		seed([snap()]);
		await mount(<SubagentPanel subagent={{ tabId: TAB, agentId: "r1" }} />);
		const before = fetched();
		const firstRow = view().querySelector(".omp-transcript-row");
		const rows = all(".omp-transcript-row").length;

		// A frame arrives, the transcript holds nothing new: one more read, the very same rows.
		seed([snap({ lastUpdate: NOW + 1000 })]);
		await flush();
		await flush();
		expect(fetched()).toBe(before + 1);
		expect(all(".omp-transcript-row").length).toBe(rows);
		expect(view().querySelector(".omp-transcript-row")).toBe(firstRow);

		// A new reply lands: it appears, the earlier rows stay the same elements.
		pages = [
			...pages,
			{
				role: "assistant",
				timestamp: NOW * 1000 + 99,
				content: [{ type: "text", text: "Tests are still running." }],
			},
		];
		seed([snap({ lastUpdate: NOW + 2000 })]);
		await flush();
		await flush();
		expect(view().textContent).toContain("Tests are still running.");
		expect(view().querySelector(".omp-transcript-row")).toBe(firstRow);
	});

	it("says so when the transcript cannot be read, and retries", async () => {
		commandForTab.mockImplementation(async (_tabId, command) => ({
			type: "response",
			command: command.type,
			success: false,
			error: "Snapshot unavailable",
		}));
		seed([snap()]);
		await mount(<SubagentPanel subagent={{ tabId: TAB, agentId: "r1" }} />);
		expect(view().textContent).toContain(translate("subagent.transcriptFailed"));
		expect(view().textContent).toContain("Snapshot unavailable");
		expect(view().textContent).toContain(translate("common.retry"));
	});
});

describe("Subagent view steer box", () => {
	it("is the composer's field and round send button, compact, for a running agent", async () => {
		seed([snap()]);
		await mount(<SubagentPanel subagent={{ tabId: TAB, agentId: "r1" }} />);
		const steer = view().querySelector("[data-subagent-steer]");
		expect(steer?.querySelector(".omp-composer-box")).not.toBeNull();
		expect(steer?.querySelector("textarea.omp-composer-input")?.getAttribute("placeholder")).toBe(
			translate("subagent.steer.placeholder"),
		);
		const send = steer?.querySelector("button.omp-composer-action");
		expect(send?.getAttribute("aria-label")).toBe(translate("subagent.steer.send"));
		// Nothing typed: nothing to send.
		expect(send?.getAttribute("disabled")).not.toBeNull();
	});
});

describe("transcriptToText", () => {
	it("keeps the conversation's prose under role labels and leaves tool work out", () => {
		expect(transcriptToText(run(), { user: "Task", assistant: "explore" })).toBe(
			"Task\nMap the settings code\n\nexplore\n## Settings map\n\n```ts\nexport const answer = 42;\n```\n\nThree layers.",
		);
	});
});

describe("narrow-column styles", () => {
	const stylesheet = readFileSync(new URL("../../styles/subagent-view.css", import.meta.url), "utf8");
	const entry = readFileSync(new URL("../../main.tsx", import.meta.url), "utf8");

	it("is loaded and fits the editorial insets to the panel's own width", () => {
		expect(entry).toContain('import "./styles/subagent-view.css"');
		expect(stylesheet).toContain("container-type: inline-size");
		expect(stylesheet).toContain("--omp-editorial-inset: clamp(var(--sc-space-3), 4cqw, var(--sc-space-8))");
	});

	it("keeps long code and wide tables inside their own scrolling block", () => {
		expect(stylesheet).toMatch(/\.markdown-body pre \{[^}]*overflow-x: auto/);
		expect(stylesheet).toMatch(/\.markdown-body table \{[^}]*overflow-x: auto/);
	});
});
