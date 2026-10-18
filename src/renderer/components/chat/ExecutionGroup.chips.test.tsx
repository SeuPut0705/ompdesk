import { parseHTML } from "linkedom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const writeText = vi.fn(async (_text: string) => {});
Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText } });

// React DOM must initialize after linkedom globals; static imports initialize it too early.
const { createRoot } = await import("react-dom/client");
const { ExecutionGroup } = await import("./ExecutionGroup");

let container: HTMLElement;
let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	writeText.mockClear();
	useToolsStore.getState().reset();
	useUiStore.setState({ panelVisible: false, panelTab: "terminal", previewUrl: null });
});

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

/** The card with its own open state, and a body holding one tool card per call id. */
function Card({ ids, live = false }: { ids: string[]; live?: boolean }) {
	const [expanded, setExpanded] = useState(false);
	return (
		<I18nProvider>
			<ExecutionGroup
				expanded={expanded}
				live={live}
				onExpandedChange={setExpanded}
				stepCount={ids.length}
				toolCallIds={ids}
			>
				{ids.map(id => (
					<div data-tool-call-id={id} key={id}>
						<button
							aria-expanded="false"
							onClick={event => event.currentTarget.setAttribute("aria-expanded", "true")}
							type="button"
						>
							{id}
						</button>
					</div>
				))}
			</ExecutionGroup>
		</I18nProvider>
	);
}

async function mount(entries: [string, ToolEntry][], live = false) {
	useToolsStore.setState(toolEntriesState(entries));
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<Card ids={entries.map(([id]) => id)} live={live} />));
}

const chip = (name: string) => container.querySelector(`[data-work-finding="${name}"]`) as unknown as HTMLElement | null;
const click = (element: HTMLElement | null) =>
	act(async () => element?.dispatchEvent(new Event("click", { bubbles: true }) as never));
const body = () => container.querySelector(".omp-execution-group-body");
async function wait(ms: number) {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	await act(async () => promise);
}

describe("work card chips", () => {
	it("Tests ✓ N opens the steps at the test run", async () => {
		const scrolled = vi.fn();
		Object.assign(HTMLElement.prototype, { scrollIntoView: scrolled });
		await mount([
			["edit-1", edit],
			["test-1", bash("bunx vitest run", " Tests  128 passed (128)", 0, 1_000)],
			["ls-1", bash("ls", "a", 0, 2_000)],
		]);
		expect(chip("tests")?.textContent).toBe("Tests128");
		expect(body()).toBeNull();
		await click(chip("tests"));
		expect(body()).not.toBeNull();
		await wait(120);
		const run = container.querySelector('[data-tool-call-id="test-1"]') as unknown as HTMLElement;
		expect(run.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
		expect(scrolled).toHaveBeenCalledTimes(1);
	});

	it("shows no Tests chip for a run whose tests failed, and Error opens the failing call", async () => {
		const scrolled = vi.fn();
		Object.assign(HTMLElement.prototype, { scrollIntoView: scrolled });
		await mount([
			["ok-1", bash("ls", "a", 0, 0)],
			["test-1", bash("bunx vitest run", "FAIL src/a.test.ts\n  ✕ adds\nTests  1 failed | 4 passed (5)", 1, 1_000)],
		]);
		expect(chip("tests")).toBeNull();
		expect(chip("error")?.textContent).toBe("FAIL src/a.test.ts");
		await click(chip("error"));
		await wait(120);
		const run = container.querySelector('[data-tool-call-id="test-1"]') as unknown as HTMLElement;
		expect(run.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelector('[data-tool-call-id="ok-1"] button')?.getAttribute("aria-expanded")).toBe("false");
		expect(scrolled).toHaveBeenCalledTimes(1);
	});

	it("names a failed step that is no command by the word Error", async () => {
		await mount([
			[
				"read-1",
				{
					toolName: "read",
					args: { path: "missing.ts" },
					status: "error",
					streamingArgs: "",
					result: { content: [{ type: "text", text: "ENOENT" }] },
					isError: true,
					startTime: 0,
					endTime: 1,
				},
			],
		]);
		expect(chip("error")?.textContent).toBe("Error");
		expect(container.querySelector("[data-work-cause]")).toBeNull();
	});

	it("offers Preview for a dev server's address and opens it in the Preview panel", async () => {
		await mount([
			["dev-1", bash("npm run dev", "  VITE v7  ready in 300 ms\n  Local: http://localhost:5173/", 0, 0)],
		]);
		expect(chip("preview")?.textContent).toBe("Preview");
		await click(chip("preview"));
		expect(useUiStore.getState()).toMatchObject({
			previewUrl: "http://localhost:5173/",
			panelTab: "preview",
			panelVisible: true,
		});
	});

	it("shows no Preview chip for a client's address", async () => {
		await mount([["curl-1", bash("curl -s http://localhost:3000/health", "http://localhost:3000", 0, 0)]]);
		expect(chip("preview")).toBeNull();
		expect(container.querySelector(".omp-work-findings")).toBeNull();
	});

	it("keeps the findings row out of a running card", async () => {
		await mount([["edit-1", edit]], true);
		expect(container.querySelector(".omp-work-findings")).toBeNull();
	});

	it("copies the card as plain text: head facts, cause, changed files with their lines, checks", async () => {
		await mount([
			["edit-1", edit],
			[
				"types-1",
				bash(
					"bun run check:types",
					"src/a.ts(1,1): error TS2322: nope\nerror: script exited with code 2",
					2,
					1_000,
				),
			],
		]);
		const copy = container.querySelector(".omp-work-copy") as unknown as HTMLElement;
		expect(copy.getAttribute("aria-label")).toBe("Copy summary");
		await click(copy);
		expect(writeText).toHaveBeenCalledTimes(1);
		const text = writeText.mock.calls[0]?.[0] ?? "";
		expect(text).toContain("1 file changed +2 −1");
		expect(text).toContain("type check failed");
		expect(text).toContain("Cause: src/a.ts(1,1): error TS2322: nope");
		expect(text).toContain("Changed files (1)\n- src/a.ts +2 -1");
		expect(text).toContain("Checks\n- ✕ type check failed");
	});
});
