import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { en } from "../../locales/en";
import { ko } from "../../locales/ko";
import { useMessagesStore } from "../../stores/messages";
import { useSubagentsStore } from "../../stores/subagents";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";

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
const { OutputMeter } = await import("./TurnOutputMeter");

const stylesheet = readFileSync(new URL("../../styles/components.css", import.meta.url), "utf8");
const realLocalStorage = (globalThis as Record<string, unknown>).localStorage;
let container: HTMLElement;
let root: Root | undefined;

/** Bodies of every `@container <query> { … }` block, braces balanced. */
function containerBlocks(query: string): string {
	const blocks: string[] = [];
	let from = 0;
	for (;;) {
		const start = stylesheet.indexOf(`@container ${query} {`, from);
		if (start === -1) return blocks.join("\n");
		let depth = 0;
		let index = stylesheet.indexOf("{", start);
		const open = index;
		for (; index < stylesheet.length; index++) {
			if (stylesheet[index] === "{") depth++;
			else if (stylesheet[index] === "}" && --depth === 0) break;
		}
		blocks.push(stylesheet.slice(open + 1, index));
		from = index;
	}
}

function rule(css: string, selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return css.match(new RegExp(`(?:^|[\\s}])${escaped} \\{([^}]+)\\}`))?.[1] ?? "";
}

function setLanguage(lang: "en" | "ko"): void {
	(globalThis as Record<string, unknown>).localStorage = {
		getItem: (key: string) => (key === "omp.lang" ? lang : null),
		setItem: () => {},
	};
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<I18nProvider>{element}</I18nProvider>));
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	(globalThis as Record<string, unknown>).localStorage = realLocalStorage;
	useToolsStore.getState().reset();
	useMessagesStore.getState().reset();
	useSubagentsStore.getState().reset();
	vi.useRealTimers();
});

function entry(patch: Partial<ToolEntry>): ToolEntry {
	return {
		toolName: "bash",
		args: {},
		status: "running",
		streamingArgs: "",
		result: null,
		isError: false,
		startTime: 1,
		endTime: null,
		...patch,
	};
}

async function mountGroup(entries: [string, ToolEntry][]): Promise<void> {
	useToolsStore.setState(toolEntriesState(entries));
	await mount(
		<ExecutionGroup
			expanded={false}
			onExpandedChange={() => {}}
			stepCount={entries.length}
			toolCallIds={entries.map(([id]) => id)}
			live
		>
			<div />
		</ExecutionGroup>,
	);
}

describe("work card on a narrow window (#21)", () => {
	// The head's columns (whole summary parts, never a cut figure) are pinned on a real layout by the work-card case of
	// e2e/responsive-smoke.e2e.ts.
	it("lets the summary row drop whole parts inside the card", () => {
		expect(rule(stylesheet, ".omp-work-head-side")).toContain("min-width: 0");
		// The summary line drops whole parts instead of ellipsizing each (ExecutionGroup.summary-and-notes.test.tsx).
		const summary = rule(stylesheet, ".omp-summary-line");
		expect(summary).toContain("min-width: 0");
		expect(summary).toContain("overflow: hidden");
		// The row's negative end margin is matched by its max width, or Chromium clamps it short of
		// its content and cuts the counts at normal width (seen as "1 s… · 187 tokens").
		const row = rule(stylesheet, ".omp-execution-group-header--embedded");
		expect(row).toContain("margin-inline-end: calc(var(--sc-space-1-5) * -1)");
		expect(row).toContain("max-width: calc(100% + var(--sc-space-1-5))");
	});
});

describe("work card in a short 2×2 pane (#23)", () => {
	const short = containerBlocks("omp-workspace (max-height: 480px)");
	it("stacks lanes as compact rows that scroll inside the card, a third one peeking in", () => {
		const lanes = rule(short, ".omp-work-cards");
		expect(lanes).toContain("grid-template-columns: minmax(0, 1fr)");
		expect(lanes).toContain("max-height: calc(20px * 2.5 + 2px)");
		expect(lanes).not.toContain("repeat(2");
		expect(rule(short, ".omp-work-card-button")).toContain("min-height: 20px");
	});
	it("keeps each lane's count so its separator never orphans, and names keep their base width", () => {
		expect(rule(short, ".omp-work-card-count")).toBe("");
		expect(short).not.toMatch(/\.omp-work-card-count \{[^}]*display: none/);
		expect(rule(short, ".omp-work-card-name")).toBe("");
		expect(rule(short, ".omp-work-card-progress")).toContain("min-width: 0");
		expect(rule(short, ".omp-work-card-elapsed")).toContain("white-space: pre");
	});
	it("shares one notes row between notes, each ending in an ellipsis instead of a cut-off scroller", () => {
		expect(short).not.toContain("overflow-x: auto");
		const item = rule(short, '.omp-work-notes:not(:has([aria-expanded="true"])) .omp-work-notes-item');
		expect(item).toContain("flex: 1 1 0");
		expect(item).toContain("min-width: 0");
		expect(rule(stylesheet, ".omp-work-notes-preview")).toContain("text-overflow: ellipsis");
		expect(rule(short, ".omp-work-steer-text")).toContain("-webkit-line-clamp: 1");
	});
});

describe("note times (#31)", () => {
	it("reads every note kind, steer included, as a relative past time with the clock on hover", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 9, 13, 10, 0, 0));
		setLanguage("ko");
		const at = new Date(2026, 9, 13, 9, 57, 0).getTime();
		const steer: AgentMessage = { role: "user", content: "Also count the files", timestamp: at };
		const advisor: AgentMessage = {
			role: "custom",
			customType: "advisor",
			id: "advisor",
			content: "Advisor content",
			details: { notes: [{ note: "Check access", severity: "concern" }] },
			timestamp: at,
		};
		await mount(<WorkNotes messages={[steer, advisor]} />);
		const times = [...container.querySelectorAll(".omp-work-notes-age")];
		expect(times.map(time => time.textContent)).toEqual(["3분 전", "3분 전"]);
		expect(times.map(time => time.tagName.toLowerCase())).toEqual(["time", "time"]);
		expect(times.map(time => time.getAttribute("title"))).toEqual(["09:57", "09:57"]);
	});
});

describe("token rate and count wording (#32)", () => {
	it("names the rate once across card, model picker and stats", () => {
		for (const [locale, unit] of [
			[en, "tok/s"],
			[ko, "tok/s"],
		] as const) {
			expect(locale["chat.meter.rate"]).toBe(`{rate} ${unit}`);
			expect(locale["chat.meter.average"]).toContain(`{rate} ${unit}`);
			expect(locale["modelPicker.speed"]).toBe(`~{value} ${unit}`);
			expect(locale["stats.col.tps"]).toBe(unit);
			expect(locale["stats.models.throughput"]).toContain(`(${unit})`);
			expect(locale["stats.overview.tokensPerSecond"]).toBe(`{rate} ${unit}`);
		}
	});
	it("spaces Korean counts from their unit", async () => {
		expect(ko["chat.work.progress"]).toBe("도구 {tools}개 · {tokens} 토큰");
		setLanguage("ko");
		await mount(<OutputMeter average estimated={false} rate={68} tokens={8000} />);
		expect(container.textContent).toBe("· 8.0k 토큰 · 평균 68 tok/s");
	});
});

describe("more/less wording (#33)", () => {
	it("uses one more/less pair for every folded list in the card", () => {
		for (const locale of [en, ko]) {
			expect(locale["chat.workNotes.more"]).toBe(locale["chat.work.more"]);
			expect(locale["chat.workNotes.less"]).toBe(locale["chat.work.fewer"]);
		}
		expect(ko["chat.work.more"]).toBe("{count}개 더 보기");
		expect(ko["chat.work.fewer"]).toBe("접기");
	});
});

describe("running label (#34)", () => {
	it("labels the running card mark in the UI language", async () => {
		setLanguage("ko");
		await mountGroup([["one", entry({ args: { command: "sleep 5" } })]]);
		const mark = container.querySelector(".omp-work-head [role='img']");
		expect(mark?.getAttribute("aria-label")).toBe("실행 중");
		expect(mark?.getAttribute("title")).toBe("실행 중");
	});
});

describe("one narrative language (#30)", () => {
	it("uses the model's intent as soon as it has streamed, not the localized tool label", async () => {
		setLanguage("ko");
		await mountGroup([
			[
				"one",
				entry({
					toolName: "read",
					status: "pending",
					args: { i: "Reading config", path: "a" },
					streamingArgs: '{"i":"Reading config","path":"a',
				}),
			],
		]);
		expect(container.querySelector(".omp-work-narrative")?.textContent).toBe("Reading config");
	});
});
