import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { ko } from "../../locales/ko";
import { useMessagesStore } from "../../stores/messages";
import { useSubagentsStore } from "../../stores/subagents";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";
import { getToolSummary } from "../tools/index";
import { workNarrative, workOutcomes } from "./work/work-view";

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
const { ExecutionGroup } = await import("./ExecutionGroup");
const { WorkNotes } = await import("./work/WorkNotes");

const stylesheet = readFileSync(new URL("../../styles/components.css", import.meta.url), "utf8");
let container: HTMLElement;
let root: Root | undefined;

function rule(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return stylesheet.match(new RegExp(`(?:^|[\\s}])${escaped} \\{([^}]+)\\}`))?.[1] ?? "";
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	useToolsStore.getState().reset();
	useMessagesStore.getState().reset();
	useSubagentsStore.getState().reset();
});

function done(toolName: string, args: Record<string, unknown>, startTime: number, endTime: number): ToolEntry {
	return { toolName, args, status: "done", streamingArgs: "", result: null, isError: false, startTime, endTime };
}

describe("summary row on a narrow card", () => {
	it("lays the time, each fact and each meter figure out as whole parts of one clipped line", async () => {
		useToolsStore.setState(
			toolEntriesState([
				["edit-1", done("edit", { path: "src/a.ts" }, 1_000, 3_000)],
				["bash-1", done("bash", { command: "bun test" }, 3_000, 17_000)],
			]),
		);
		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		await act(async () =>
			root?.render(
				<I18nProvider>
					<ExecutionGroup
						expanded={false}
						onExpandedChange={() => {}}
						stepCount={2}
						toolCallIds={["edit-1", "bash-1"]}
						output={{ tokens: 408, rate: 46 }}
					>
						<div />
					</ExecutionGroup>
				</I18nProvider>,
			),
		);
		const line = container.querySelector(".omp-summary-line");
		const parts = [...(line?.querySelectorAll(".omp-summary-part") ?? [])].map(part => part.textContent);
		// Seen as "2 commands · 2 age… · 2.1s · 408 tokens · avg 46 …" in a 2×2 pane: every figure is its own part, so
		// a narrow card drops whole parts from the end instead. The head's own parts are the time, the step count
		// and the meter; the file and the command are the chips' (and the label's).
		expect(parts).toEqual(["16.0s", "2 steps", "· 408 tokens", " · avg 46 tok/s"]);
		expect(container.querySelector(".omp-execution-group-summary")?.textContent).toBe("2 steps");
		const box = rule(".omp-summary-line");
		expect(box).toContain("flex-wrap: wrap");
		expect(box).toContain("height: 1lh");
		expect(box).toContain("overflow: hidden");
		expect(rule(".omp-summary-line :is(.omp-execution-group-summary, .omp-output-meter)")).toContain(
			"display: contents",
		);
		expect(rule(".omp-summary-part")).toContain("white-space: nowrap");
		expect(container.querySelector(".omp-execution-group-header")?.getAttribute("aria-label")).toBe(
			"Steps: 1 file changed · 1 command · 16.0s",
		);
	});
});

describe("streaming caret", () => {
	it("marks only output whose nearest card step is still running", () => {
		const selector = stylesheet
			.match(/\n(\.omp-work-motion\[data-running="true"\] \.omp-bash-line:last-child[^,{]*)::after,/)?.[1]
			?.trim();
		expect(selector).toBeTruthy();
		const host = document.createElement("div");
		host.innerHTML = `
			<div class="omp-live-step omp-work-motion" data-running="true">
				<div class="omp-bash-output"><span class="omp-bash-line">main</span><span class="omp-bash-line" id="main">tail</span></div>
				<div class="omp-live-step omp-work-motion" data-nested="true" data-running="false">
					<div class="omp-bash-output"><span class="omp-bash-line" id="lane-done">exit 0</span></div>
				</div>
				<div class="omp-live-step omp-work-motion" data-nested="true" data-running="true">
					<div class="omp-bash-output"><span class="omp-bash-line" id="lane-live">counting</span></div>
				</div>
			</div>`;
		const marked = [...host.querySelectorAll(selector ?? "")].map(line => line.id);
		expect(marked).toEqual(["main", "lane-live"]);
	});
});

describe("Korean narrative", () => {
	it("names an intent-less wait in the UI language only", () => {
		const realLocalStorage = (globalThis as Record<string, unknown>).localStorage;
		(globalThis as Record<string, unknown>).localStorage = {
			getItem: (key: string) => (key === "omp.lang" ? "ko" : null),
			setItem: () => {},
		};
		try {
			const t = (key: string, params: Record<string, string | number> = {}) =>
				(ko as Record<string, string>)[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ""));
			expect(workNarrative("wait", {}, t)).toBe("대기 백그라운드 작업");
			expect(getToolSummary("wait", { i: "Waiting for the build" })).toBe("Waiting for the build");
		} finally {
			(globalThis as Record<string, unknown>).localStorage = realLocalStorage;
		}
	});
});

describe("Korean advisor note", () => {
	it("states stock's severity in the UI language on the note's badge", async () => {
		const realLocalStorage = (globalThis as Record<string, unknown>).localStorage;
		(globalThis as Record<string, unknown>).localStorage = {
			getItem: (key: string) => (key === "omp.lang" ? "ko" : null),
			setItem: () => {},
		};
		try {
			container = document.createElement("div") as unknown as HTMLElement;
			document.body.appendChild(container as never);
			root = createRoot(container as unknown as Element);
			const advisor: AgentMessage = {
				role: "custom",
				customType: "advisor",
				id: "advisor",
				content: "Advisor content",
				details: { notes: [{ note: "Check access", severity: "concern" }] },
				timestamp: 1,
			};
			await act(async () =>
				root?.render(
					<I18nProvider>
						<WorkNotes messages={[advisor]} />
					</I18nProvider>,
				),
			);
			// Seen as an English "concern" badge in an otherwise Korean card.
			expect(container.querySelector(".omp-work-notes-line")?.textContent).toContain("우려");
			expect(container.textContent).not.toContain("concern");
		} finally {
			(globalThis as Record<string, unknown>).localStorage = realLocalStorage;
		}
	});
});

describe("expanded work note", () => {
	it("states its time once, on the note's line, not again in the opened message", async () => {
		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		const irc: AgentMessage = {
			role: "custom",
			customType: "irc:incoming",
			id: "irc",
			content: "Workspace coordination is ready.",
			details: { from: "ReaMcp", to: "main", message: "Workspace coordination is ready." },
			timestamp: Date.now() - 120_000,
		};
		await act(async () =>
			root?.render(
				<I18nProvider>
					<WorkNotes messages={[irc]} />
				</I18nProvider>,
			),
		);
		await act(async () => (container.querySelector(".omp-work-notes-line") as HTMLButtonElement | null)?.click());
		expect(container.querySelector(".omp-work-notes-body")).not.toBeNull();
		// Seen as "just now" twice, the second in a different (mono) face.
		expect(container.querySelectorAll("time")).toHaveLength(1);
	});
});

describe("outcome picture caption", () => {
	it("names a browser capture by the page it shows, not by its action", () => {
		const capture: ToolEntry = {
			...done("browser", { action: "run", code: "await tab.screenshot()" }, 1, 2),
			result: {
				content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
				details: { url: "https://example.com/workspace?tab=1" },
			},
		};
		const [image] = workOutcomes([capture]).images;
		// Seen as "run" under the thumbnail.
		expect(image?.caption).toBe("example.com/workspace");
		expect(image?.label).toBe("https://example.com/workspace?tab=1");
	});
});
