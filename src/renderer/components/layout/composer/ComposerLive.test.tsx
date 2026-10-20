import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcAsyncJobItem, RpcJobRow, SubagentSnapshot } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { liveWorkState, workingAgentCount } from "../live-work";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let rows: RpcJobRow[] = [];
const getJobs = vi.fn(async () => ({ type: "response", command: "get_jobs", success: true, data: { rows } }));
Reflect.set(window, "omp", { rpc: { getJobs } });

const { createRoot } = await import("react-dom/client");
const { ComposerLiveEdge, ComposerSend } = await import("./ComposerLive");

let container: HTMLElement;
let root: Root;

const agent = (id: string, status: string): SubagentSnapshot => ({
	id,
	index: 0,
	agent: "task",
	status,
	lastUpdate: 0,
});
const job = (id: string, type: RpcAsyncJobItem["type"], status: RpcAsyncJobItem["status"], depth = 0): RpcJobRow => ({
	kind: "job",
	depth,
	cancellable: depth === 0,
	job: { id, type, status, label: id, startTime: 0 },
});

async function mount(): Promise<void> {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t1",
		bundles: new Map(),
	});
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ComposerLiveEdge />
				<ComposerSend label="Send">
					<button type="button">send</button>
				</ComposerSend>
			</I18nProvider>,
		);
	});
	await act(async () => {});
}

const edge = () => container.querySelector(".omp-live-edge");
const sendWrap = () => container.querySelector(".omp-composer-send-live");

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	rows = [];
	getJobs.mockClear();
	useSubagentsStore.getState().reset();
	useExtensionUiStore.getState().clearAll();
	useTabsStore.getState().reset();
	useSessionStore.setState({ isStreaming: false });
	Reflect.set(document, "visibilityState", "visible");
});

describe("liveWorkState", () => {
	it("maps the run state, background work and a waiting question to one cue", () => {
		const idle = { streaming: false, waiting: 0, background: 0 };
		expect(liveWorkState(idle)).toBeNull();
		expect(liveWorkState({ ...idle, streaming: true })).toBe("turn");
		expect(liveWorkState({ ...idle, background: 2 })).toBe("background");
		// A running turn outranks background work.
		expect(liveWorkState({ streaming: true, waiting: 0, background: 2 })).toBe("turn");
		// A question or approval waiting on the user wins over both: the edge holds a still warning tint.
		expect(liveWorkState({ streaming: true, waiting: 1, background: 0 })).toBe("waiting");
		expect(liveWorkState({ streaming: false, waiting: 1, background: 3 })).toBe("waiting");
	});

	it("counts working subagents, not waiting or finished ones", () => {
		const agents = [
			agent("a", "running"),
			agent("b", "parked"),
			agent("c", "idle"),
			agent("d", "completed"),
			agent("e", "pending"),
		];
		expect(workingAgentCount(agents)).toBe(2);
	});
});

describe("ComposerLiveEdge", () => {
	it("is absent while idle and shows `turn` while the turn runs", async () => {
		await mount();
		expect(edge()).toBeNull();
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		expect(edge()?.getAttribute("data-live-edge")).toBe("turn");
		expect(sendWrap()?.hasAttribute("data-composer-live")).toBe(false);
	});

	it("shows `background` between turns for a working subagent, and rings Send", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running"), agent("a2", "running")]);
		await mount();
		expect(edge()?.getAttribute("data-live-edge")).toBe("background");
		expect(sendWrap()?.getAttribute("data-composer-live")).toBe("background");
	});

	it("ignores a finished shell, a task job and a parked agent", async () => {
		rows = [job("j1", "bash", "completed"), job("j2", "task", "running")];
		useSubagentsStore.getState().setSnapshots([agent("p", "parked")]);
		await mount();
		expect(edge()).toBeNull();
		expect(sendWrap()?.hasAttribute("data-composer-live")).toBe(false);
	});

	it("shows `background` while a shell runs", async () => {
		rows = [job("j3", "bash", "running")];
		await mount();
		expect(edge()?.getAttribute("data-live-edge")).toBe("background");
	});

	it("shows `background` while only a subagent's own shell runs", async () => {
		rows = [job("j1", "task", "completed"), job("j4", "bash", "running", 1)];
		await mount();
		expect(edge()?.getAttribute("data-live-edge")).toBe("background");
	});

	it("shows `background` while main reports the tab unsettled after its turn, with nothing in its own lists", async () => {
		await mount();
		expect(edge()).toBeNull();
		await act(async () =>
			useTabsStore.setState(state => ({
				tabs: state.tabs.map(tab => ({ ...tab, status: "running", settling: true as const })),
			})),
		);
		expect(edge()?.getAttribute("data-live-edge")).toBe("background");
	});

	it("lets the comet go while a question waits on the user, whatever else runs, and holds a still tint", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running")]);
		await mount();
		expect(edge()?.getAttribute("data-live-edge")).toBe("background");
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "q",
				method: "select",
				title: "Allow tool: bash\nls",
				options: ["Approve", "Deny"],
			}),
		);
		expect(edge()?.getAttribute("data-live-edge")).toBe("waiting");
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		expect(edge()?.getAttribute("data-live-edge")).toBe("waiting");
		expect(sendWrap()?.hasAttribute("data-composer-live")).toBe(false);
	});

	it("rests while the window is hidden", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		expect(edge()?.hasAttribute("data-paused")).toBe(false);
		Reflect.set(document, "visibilityState", "hidden");
		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		expect(edge()?.hasAttribute("data-paused")).toBe(true);
	});
});

describe("the cue beside a draft", () => {
	const css = readFileSync(new URL("../../../styles/components.css", import.meta.url), "utf8");
	/** Declarations of the top-level rule whose selector is exactly `selector`. */
	const rule = (selector: string) => {
		const start = css.indexOf(`\n${selector} {`);
		return start < 0 ? "" : css.slice(start, css.indexOf("}", start));
	};

	it("dims to a faint trace beside a draft, focused or not, and steps the Send ring out of the way", () => {
		// AGENTS.md: the cue steps back while the field holds a draft (DR-19: not gone: a faint trace stays).
		const gain = rule(".omp-composer-box[data-composer-draft] .omp-live-edge").match(/--live-gain: ([\d.]+);/)?.[1];
		expect(Number(gain)).toBeGreaterThan(0);
		expect(Number(gain)).toBeLessThan(0.5);
		const ring = rule(".omp-composer-box[data-composer-draft] .omp-composer-send-live[data-composer-live]::after");
		expect(ring).toContain("opacity: 0");
	});

	it("takes a still 1px line on the box's top edge at ~40% under reduced motion, not a permanent ring", () => {
		const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n\t.omp-live-edge"));
		const reduced = block.slice(0, block.indexOf("\n}\n"));
		expect(reduced).toMatch(
			/\.omp-live-edge\[data-live-edge="turn"\] \{\s*border-top-color: color-mix\(in srgb, var\(--sc-accent\) 40%/,
		);
	});
});
