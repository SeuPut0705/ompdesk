import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";

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

let container: HTMLElement;
let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	useToolsStore.getState().reset();
	useUiStore.setState({ panelVisible: false, panelTab: "terminal" });
});

/** A stock bash result: its text and `details.exitCode`. */
function bash(command: string, text: string, exitCode: number, at: number): ToolEntry {
	return {
		toolName: "bash",
		args: { command },
		status: exitCode ? "error" : "done",
		streamingArgs: "",
		result: { content: [{ type: "text", text }], details: { exitCode } },
		isError: exitCode !== 0,
		startTime: at,
		endTime: at + 1_000,
	};
}

const edit: ToolEntry = {
	toolName: "edit",
	args: { path: "src/a.ts" },
	status: "done",
	streamingArgs: "",
	result: { content: [{ type: "text", text: "ok" }], details: { diff: "+1 one\n+2 two\n-3 three" } },
	isError: false,
	startTime: 0,
	endTime: 500,
};

async function mount(entries: [string, ToolEntry][], onExpand: (next: boolean) => void = () => {}) {
	useToolsStore.setState(toolEntriesState(entries));
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<ExecutionGroup
					expanded={false}
					onExpandedChange={onExpand}
					stepCount={entries.length}
					toolCallIds={entries.map(([id]) => id)}
				>
					<div />
				</ExecutionGroup>
			</I18nProvider>,
		),
	);
}

/** Every fact of the run, as the head button's accessible name lists them. */
const facts = () =>
	(container.querySelector(".omp-execution-group-header")?.getAttribute("aria-label") ?? "")
		.replace(/^Steps: /, "")
		.split(" · ");

const finding = (name: string) => container.querySelector(`[data-work-finding="${name}"]`) as unknown as HTMLElement;
const mark = () => container.querySelector(".omp-work-head > .omp-work-status");
const click = (element: HTMLElement) =>
	act(async () => element.dispatchEvent(new Event("click", { bubbles: true }) as never));

/** A type check whose command did not error as a tool call: only its exit code says it failed. */
const typesFailedQuietly: ToolEntry = {
	...bash(
		"bun run check:types",
		"src/a.ts(3,3): error TS2322: Type 'string' is not assignable to type 'boolean'.",
		2,
		0,
	),
	status: "done",
	isError: false,
};

describe("work card findings", () => {
	it("names what the checks did instead of counting commands", async () => {
		await mount([
			["edit-1", edit],
			["test-1", bash("bunx vitest run", " Tests  128 passed (128)", 0, 1_000)],
			["status-1", bash("git status --short", " M src/a.ts", 0, 3_000)],
		]);
		expect(facts()).toContain("128 tests passed");
		expect(facts()).toContain("1 command");
		expect(finding("tests").getAttribute("aria-label")).toBe("128 tests passed");
		expect(container.querySelector("[data-work-cause]")).toBeNull();
	});

	it("says each fact once: the strip holds files and checks, the head only what the strip does not", async () => {
		await mount([
			["edit-1", edit],
			["test-1", bash("bunx vitest run", " Tests  128 passed (128)", 0, 1_000)],
			["status-1", bash("git status --short", " M src/a.ts", 0, 3_000)],
		]);
		expect(container.querySelector(".omp-execution-group-summary")?.textContent).toBe("1 command");
		expect(finding("changes")).not.toBeNull();
		expect(finding("tests")).not.toBeNull();
	});

	it("shows a failed build's cause, which opens the steps", async () => {
		let expanded = false;
		await mount(
			[["build-1", bash("bun run build", "vite v7\nerror during build: Could not resolve './x'\n", 1, 0)]],
			next => {
				expanded = next;
			},
		);
		expect(facts()).toContain("build failed");
		const cause = container.querySelector("[data-work-cause]") as unknown as HTMLElement;
		expect(cause.textContent).toBe("error during build: Could not resolve './x'");
		await click(cause);
		expect(expanded).toBe(true);
	});
});

describe("work card verdict", () => {
	it("marks a passing run done with a tick", async () => {
		await mount([["types-1", bash("bun run check:types", "ok", 0, 0)]]);
		expect(mark()?.getAttribute("data-state")).toBe("complete");
		expect(container.querySelector(".omp-work-narrative")?.textContent).toBe("Work complete");
		expect(container.querySelector(".omp-execution-group")?.getAttribute("data-verdict")).toBeNull();
		expect(finding("check-typecheck")?.getAttribute("data-tone")).toBe("ok");
	});

	it("reads a run whose type check failed as failed, though no command errored", async () => {
		let expanded = false;
		await mount([["types-1", typesFailedQuietly]], next => {
			expanded = next;
		});
		expect(mark()?.getAttribute("data-state")).toBe("failed");
		expect(mark()?.getAttribute("aria-label")).toBe("Done, but a check failed");
		expect(container.querySelector(".omp-work-narrative")?.textContent).toBe("Done, but a check failed");
		expect(container.querySelector(".omp-execution-group")?.getAttribute("data-verdict")).toBe("failed");
		expect(finding("check-typecheck").getAttribute("data-tone")).toBe("fail");
		await click(finding("check-typecheck"));
		expect(expanded).toBe(true);
		expect(container.querySelector("[data-work-cause]")?.textContent).toContain("TS2322");
	});

	it("keeps an interrupted run interrupted, never a failed check", async () => {
		const aborted: ToolEntry = { ...bash("bun run check:types", "", 0, 0), status: "aborted", result: undefined };
		await mount([["types-1", aborted]]);
		expect(mark()?.getAttribute("data-state")).toBe("stopped");
		expect(container.querySelector(".omp-execution-group")?.getAttribute("data-verdict")).toBeNull();
		expect(container.querySelector("[data-work-finding]")).toBeNull();
	});
});

describe("work card changes", () => {
	it("offers Changes for a run that edited files and opens the diff view", async () => {
		await mount([["edit-1", edit]]);
		const chip = container.querySelector('[data-work-finding="changes"]') as unknown as HTMLElement;
		await act(async () => chip.dispatchEvent(new Event("click", { bubbles: true }) as never));
		expect(useUiStore.getState()).toMatchObject({ panelTab: "diff", panelVisible: true });
	});
});
