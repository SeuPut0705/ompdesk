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
const { ComposerLiveSweep, ComposerSend } = await import("./ComposerLive");

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
				<ComposerLiveSweep />
				<ComposerSend label="Send">
					<button type="button">send</button>
				</ComposerSend>
			</I18nProvider>,
		);
	});
	await act(async () => {});
}

const edge = () => container.querySelector(".omp-live-sweep");
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

describe("ComposerLiveSweep", () => {
	it("is absent while idle and shows `turn` while the turn runs, with no border light", async () => {
		await mount();
		expect(edge()).toBeNull();
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		expect(edge()?.getAttribute("data-working")).toBe("turn");
		expect(edge()?.getAttribute("aria-hidden")).toBe("true");
		expect(container.querySelector(".omp-live-edge, .omp-live-pill")).toBeNull();
		expect(sendWrap()?.hasAttribute("data-composer-live")).toBe(false);
	});
	it("shows `background` between turns for a working subagent, and rings Send", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running"), agent("a2", "running")]);
		await mount();
		expect(edge()?.getAttribute("data-working")).toBe("background");
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
		expect(edge()?.getAttribute("data-working")).toBe("background");
	});

	it("shows `background` while only a subagent's own shell runs", async () => {
		rows = [job("j1", "task", "completed"), job("j4", "bash", "running", 1)];
		await mount();
		expect(edge()?.getAttribute("data-working")).toBe("background");
	});

	it("shows `background` while main reports the tab unsettled after its turn, with nothing in its own lists", async () => {
		await mount();
		expect(edge()).toBeNull();
		await act(async () =>
			useTabsStore.setState(state => ({
				tabs: state.tabs.map(tab => ({ ...tab, status: "running", settling: true as const })),
			})),
		);
		expect(edge()?.getAttribute("data-working")).toBe("background");
	});

	it("stops the sweep while a question waits on the user, whatever else runs, and holds a still tint", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running")]);
		await mount();
		expect(edge()?.getAttribute("data-working")).toBe("background");
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "q",
				method: "select",
				title: "Allow tool: bash\nls",
				options: ["Approve", "Deny"],
			}),
		);
		expect(edge()?.getAttribute("data-working")).toBe("waiting");
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		expect(edge()?.getAttribute("data-working")).toBe("waiting");
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

describe("the composer's sweep in the stylesheet", () => {
	const css = readFileSync(new URL("../../../styles/components.css", import.meta.url), "utf8");
	/** Declarations of the top-level rule whose selector is exactly `selector`. */
	const rule = (selector: string) => {
		const start = css.indexOf(`\n${selector} {`);
		return start < 0 ? "" : css.slice(start, css.indexOf("}", start));
	};

	it("has no border light left", () => {
		expect(css).not.toContain("omp-live-edge");
		expect(css).not.toContain("omp-live-pill");
	});

	it("sweeps a transform only while work runs, and the waiting tint holds still", () => {
		const moving = rule('.omp-live-sweep:is([data-working="turn"], [data-working="background"])::before');
		expect(moving).toMatch(/animation: omp-live-shine-sweep /);
		const keyframes = css.slice(css.indexOf("@keyframes omp-live-shine-sweep"));
		const body = keyframes.slice(0, keyframes.indexOf("\n}\n"));
		expect(body).toContain("transform:");
		expect(body).not.toMatch(/opacity|background-position|width|left/);
		expect(rule('.omp-live-sweep[data-working="waiting"]')).toContain("var(--sc-warning)");
		expect(rule('.omp-live-sweep[data-working="waiting"]::before')).toContain("display: none");
	});

	// A looping cue that animates anything else repaints its element every frame (the title shimmer's background
	// position cost +9 % of a GPU core with four panes streaming); transform and opacity stay on the compositor.
	it("animates only transform and opacity in every working cue", () => {
		const blocks = [...css.matchAll(/@keyframes (omp-live-[\w-]+) \{([\s\S]*?)\n\}/g)];
		expect(blocks.map(([, name]) => name)).toEqual(
			expect.arrayContaining(["omp-live-shine-sweep", "omp-live-shine-text"]),
		);
		for (const [, name, body] of blocks) {
			const properties = new Set([...(body ?? "").matchAll(/^\s*([a-z-]+):/gm)].map(([, property]) => property));
			expect(
				[...properties].filter(property => property !== "transform" && property !== "opacity"),
				name,
			).toEqual([]);
		}
	});

	it("steps the Send ring out of the way beside a draft", () => {
		const ring = rule(".omp-composer-box[data-composer-draft] .omp-composer-send-live[data-composer-live]::after");
		expect(ring).toContain("opacity: 0");
	});

	it("holds every working cue still under reduced motion and software compositing", () => {
		for (const opener of [
			"@media (prefers-reduced-motion: reduce) {\n\t.omp-live-",
			'html[data-gpu="software"] .omp-live-',
		]) {
			const at = css.indexOf(opener);
			expect(at, opener).toBeGreaterThan(0);
		}
		const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n\t.omp-live-"));
		const block = reduced.slice(0, reduced.indexOf("\n}\n"));
		expect(block).toMatch(
			/\.omp-live-sweep\[data-working\]::before,\s*\.omp-live-text\[data-working\] :is\(\.omp-live-shine-window, \.omp-live-shine-words\)\s*\{\s*animation: none/,
		);
		expect(block).toMatch(/\.omp-live-shine \{\s*display: none/);
		expect(
			rule(
				'html[data-gpu="software"] .omp-live-sweep[data-working]::before,\nhtml[data-gpu="software"] .omp-live-text[data-working] :is(.omp-live-shine-window, .omp-live-shine-words)',
			),
		).toContain("animation: none");
		expect(rule('html[data-gpu="software"] .omp-live-shine')).toContain("display: none");
	});
});
