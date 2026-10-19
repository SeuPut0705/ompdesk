import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcAsyncJobItem, SubagentSnapshot } from "../../../../shared/rpc-types";
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

let jobs: RpcAsyncJobItem[] = [];
const getJobs = vi.fn(async () => ({ type: "response", command: "get_jobs", success: true, data: { jobs } }));
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
const job = (id: string, type: RpcAsyncJobItem["type"], status: RpcAsyncJobItem["status"]): RpcAsyncJobItem => ({
	id,
	type,
	status,
	label: id,
	startTime: 0,
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
	jobs = [];
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
		// A question or approval waiting on the user wins over both.
		expect(liveWorkState({ streaming: true, waiting: 1, background: 0 })).toBeNull();
		expect(liveWorkState({ streaming: false, waiting: 1, background: 3 })).toBeNull();
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
		jobs = [job("j1", "bash", "completed"), job("j2", "task", "running")];
		useSubagentsStore.getState().setSnapshots([agent("p", "parked")]);
		await mount();
		expect(edge()).toBeNull();
		expect(sendWrap()?.hasAttribute("data-composer-live")).toBe(false);
	});

	it("shows `background` while a shell runs", async () => {
		jobs = [job("j3", "bash", "running")];
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

	it("stays off while a question waits on the user, whatever else runs", async () => {
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
		expect(edge()).toBeNull();
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		expect(edge()).toBeNull();
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

	it("quiets to a faint trace beside a draft, focused or not, and steps the Send ring out of the way", () => {
		// AGENTS.md: the cue steps back while the field holds a draft (DR-19: not gone: a faint trace stays).
		expect(rule(".omp-composer-box[data-composer-draft] .omp-live-edge")).toMatch(/opacity: 0\.2\d?;/);
		const ring = rule(".omp-composer-box[data-composer-draft] .omp-composer-send-live[data-composer-live]::after");
		expect(ring).toContain("opacity: 0");
		expect(ring).toContain("animation: none");
	});

	it("takes a still 1px line at ~40% under reduced motion, not a permanent ring", () => {
		const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n\t.omp-live-edge {"));
		const reduced = block.slice(0, block.indexOf("\n}\n"));
		expect(reduced).toMatch(/\.omp-live-edge \{\s*opacity: 0\.4;/);
		expect(reduced).toContain("height: 1px");
		expect(reduced).toContain("inset: 0 0 auto 0");
		expect(reduced).toContain("animation: none");
		expect(reduced).not.toContain("70%");
	});
});
