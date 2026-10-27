import { parseHTML } from "linkedom";
import { act } from "react";
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
const { ToolCard } = await import("../tools/ToolCard");

let container: HTMLElement;
let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	useToolsStore.getState().reset();
	useUiStore.setState({ panelVisible: false, panelTab: "terminal" });
	writeText.mockClear();
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

async function mount(entries: [string, ToolEntry][], onExpand: (next: boolean) => void = () => {}, expanded = false) {
	useToolsStore.setState(toolEntriesState(entries));
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<ExecutionGroup
					expanded={expanded}
					onExpandedChange={onExpand}
					stepCount={entries.length}
					toolCallIds={entries.map(([id]) => id)}
				>
					{entries.map(([id, entry]) => (
						<ToolCard args={entry.args} key={id} toolCallId={id} toolName={entry.toolName} />
					))}
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
		expect(container.querySelector('[data-work-finding="error"]')).toBeNull();
	});

	it("says each fact once: the head its steps, the chips files and checks, the command count only the label", async () => {
		await mount([
			["edit-1", edit],
			["test-1", bash("bunx vitest run", " Tests  128 passed (128)", 0, 1_000)],
			["status-1", bash("git status --short", " M src/a.ts", 0, 3_000)],
		]);
		expect(container.querySelector(".omp-execution-group-summary")?.textContent).toBe("3 steps");
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
		const block = finding("error");
		expect(block.querySelector(".omp-work-verdict-cause")?.textContent).toBe(
			"error during build: Could not resolve './x'",
		);
		// The block is the cause: verdict, exit code and cause in one button.
		expect(block.querySelector(".omp-work-verdict-label")?.textContent).toBe("build failed");
		expect(container.querySelectorAll('[data-work-finding="error"]')).toHaveLength(1);
		const cause = block;
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
		expect(container.querySelector('[data-work-finding^="check-"]')).toBeNull();
		const block = finding("error");
		expect(block.textContent).toContain("type check failed");
		expect(block.querySelector(".omp-work-verdict-meta")?.textContent).toBe("exit 2");
		expect(block.querySelector(".omp-work-verdict-cause")?.textContent).toContain("TS2322");
		await click(block);
		expect(expanded).toBe(true);
	});

	it("keeps an interrupted run interrupted, never a failed check", async () => {
		const aborted: ToolEntry = { ...bash("bun run check:types", "", 0, 0), status: "aborted", result: undefined };
		await mount([["types-1", aborted]]);
		expect(mark()?.getAttribute("data-state")).toBe("stopped");
		expect(container.querySelector(".omp-execution-group")?.getAttribute("data-verdict")).toBeNull();
		expect(container.querySelector('[data-work-finding="error"], [data-work-finding^="check-"]')).toBeNull();
		// A stopped command is never silent: it is its own chip.
		expect(finding("stopped")?.textContent).toContain("1 interrupted");
	});
});

describe("work card failures", () => {
	it("shows one verdict block for several failures: the failing check first, the rest folded into one line", async () => {
		let expanded = false;
		await mount(
			[
				["push-1", bash("git push origin main", "fatal: denied", 128, 0)],
				["types-1", typesFailedQuietly],
				["deploy-1", bash("./deploy.sh", "deploy: no target", 2, 5_000)],
			],
			next => {
				expanded = next;
			},
		);
		const blocks = [...container.querySelectorAll('[data-work-finding="error"]')];
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.textContent).toContain("type check failed");
		const more = container.querySelector('[data-work-finding="more-failed"]') as unknown as HTMLElement;
		expect(more.textContent).toBe("+2 more failed");
		await click(more);
		expect(expanded).toBe(true);
	});

	it("shows the last failed command when no check failed, named by the program it ran", async () => {
		await mount([
			["a", bash("cd src && FOO=1 ./first.sh", "first: boom", 1, 0)],
			["b", bash("cd src && FOO=1 env git push origin main", "fatal: denied", 128, 5_000)],
		]);
		const block = finding("error");
		expect(block.querySelector(".omp-work-verdict-label")?.textContent).toBe("git push failed");
		expect(block.querySelector(".omp-work-verdict-cause")?.textContent).toBe("fatal: denied");
		expect(container.querySelector('[data-work-finding="more-failed"]')?.textContent).toBe("+1 more failed");
	});

	it("has no folded line for a single failure", async () => {
		await mount([["a", bash("./first.sh", "first: boom", 1, 0)]]);
		expect(container.querySelector('[data-work-finding="more-failed"]')).toBeNull();
	});

	it("opens the steps, with nothing to reveal, for a failed command that has no call of its own", async () => {
		let expanded = false;
		await mount([["a", bash("./first.sh", "first: boom", 1, 0)]], next => {
			expanded = next;
		});
		await click(finding("error"));
		expect(expanded).toBe(true);
	});
});

describe("work card recovery", () => {
	const rejected: ToolEntry = {
		...edit,
		status: "error",
		isError: true,
		result: { content: [{ type: "text", text: "Edit rejected: old text not found in src/a.ts" }] },
	};
	const redone: ToolEntry = { ...edit, startTime: 1_000, endTime: 1_500 };

	it("stays green for a rejected edit redone on the same path, and copies it as fixed", async () => {
		await mount([
			["edit-1", rejected],
			["edit-2", redone],
		]);
		expect(mark()?.getAttribute("data-state")).toBe("complete");
		expect(container.querySelector(".omp-execution-group")?.getAttribute("data-verdict")).toBeNull();
		expect(container.querySelector('[data-work-finding="error"]')).toBeNull();
		await click(container.querySelector(".omp-work-copy") as unknown as HTMLElement);
		expect(writeText.mock.calls[0]?.[0]).toContain("Failed, then fixed by a later run\n- ✕ → ✓ edit src/a.ts");
	});

	it("keeps the rejected edit marked failed in the opened steps of the green card", async () => {
		await mount(
			[
				["edit-1", rejected],
				["edit-2", redone],
			],
			() => {},
			true,
		);
		expect(mark()?.getAttribute("data-state")).toBe("complete");
		const step = (id: string) => container.querySelector(`.omp-tool-card[data-tool-call-id="${id}"]`);
		expect(step("edit-1")?.getAttribute("data-tool-error")).toBe("true");
		expect(step("edit-1")?.querySelector(".omp-tool-state")?.textContent).toBe("Failed");
		expect(step("edit-2")?.getAttribute("data-tool-error")).toBeNull();
	});

	it("stays red for a rejected edit when only another file was edited after it", async () => {
		await mount([
			["edit-1", rejected],
			["edit-2", { ...redone, args: { path: "src/b.ts" } }],
		]);
		expect(mark()?.getAttribute("data-state")).toBe("failed");
		expect(finding("error")).not.toBeNull();
	});

	it("stays red for a check that failed in packages/a when only packages/b passed after it, and skips a probe", async () => {
		let expanded = false;
		await mount(
			[
				[
					"test-a",
					{
						...bash("bunx vitest run", " FAIL packages/a/src/x.test.ts > adds\n Tests  1 failed (3)", 1, 0),
						args: { command: "bunx vitest run", cwd: "packages/a" },
					},
				],
				["probe", bash("command -v magick", "", 1, 2_000)],
				[
					"test-b",
					{
						...bash("bunx vitest run", " Tests  4 passed (4)", 0, 4_000),
						args: { command: "bunx vitest run", cwd: "packages/b" },
					},
				],
			],
			next => {
				expanded = next;
			},
		);
		expect(mark()?.getAttribute("data-state")).toBe("failed");
		const block = finding("error");
		expect(block.querySelector(".omp-work-verdict-label")?.textContent).toBe("1 test failed");
		expect(block.querySelector(".omp-work-verdict-cause")?.textContent).toBe("FAIL packages/a/src/x.test.ts > adds");
		expect(container.querySelectorAll('[data-work-finding="error"]')).toHaveLength(1);
		expect(container.querySelector('[data-work-finding="more-failed"]')).toBeNull();
		await click(block);
		expect(expanded).toBe(true);
	});

	it("stays red for a failed push followed only by a git status", async () => {
		await mount([
			["push-1", bash("git push origin main", "fatal: denied", 128, 0)],
			["status-1", bash("git status", "nothing to commit", 0, 2_000)],
		]);
		expect(finding("error").querySelector(".omp-work-verdict-label")?.textContent).toBe("git push failed");
	});

	it("goes green once the same push is retried and passes", async () => {
		await mount([
			["push-1", bash("git push origin main", "fatal: denied", 128, 0)],
			["push-2", bash("git push origin main", "main -> main", 0, 2_000)],
		]);
		expect(mark()?.getAttribute("data-state")).toBe("complete");
		expect(container.querySelector('[data-work-finding="error"]')).toBeNull();
	});

	it("says one thing for a check rerun inside a chain of checks: passed in the mark, no block, fixed in Copy summary", async () => {
		await mount([
			["lint-1", bash("node scripts/lint-surfaces.mjs", "✖ raw button in Foo.tsx", 1, 0)],
			["lint-2", bash("node scripts/lint-surfaces.mjs && bunx biome check src", "Checked 9 files", 0, 2_000)],
		]);
		expect(mark()?.getAttribute("data-state")).toBe("complete");
		expect(container.querySelector('[data-work-finding="error"]')).toBeNull();
		await click(container.querySelector(".omp-work-copy") as unknown as HTMLElement);
		const text = writeText.mock.calls[0]?.[0] ?? "";
		expect(text).not.toContain("- ✕ lint failed");
		expect(text).toContain("Failed, then fixed");
	});

	it("stays green for a read that found nothing", async () => {
		await mount([
			[
				"read-1",
				{
					...edit,
					toolName: "read",
					args: { path: "missing.ts" },
					status: "error",
					isError: true,
					result: { content: [{ type: "text", text: "ENOENT" }] },
				},
			],
		]);
		expect(mark()?.getAttribute("data-state")).toBe("complete");
		expect(container.querySelector('[data-work-finding="error"]')).toBeNull();
	});
});

describe("work card without output", () => {
	it("says what a run of only reads and searches read and searched in its head", async () => {
		const read = (path: string, at: number): ToolEntry => ({
			...edit,
			toolName: "read",
			args: { path },
			result: { content: [{ type: "text", text: "x" }] },
			startTime: at,
			endTime: at + 100,
		});
		const search: ToolEntry = { ...read("src", 900), toolName: "grep", args: { pattern: "x" } };
		await mount([
			["r1", read("a.ts", 0)],
			["r2", read("b.ts", 200)],
			["s1", search],
		]);
		expect(container.querySelector(".omp-execution-group-summary")?.textContent).toBe("Read 2 files · 1 search");
		expect(container.querySelector(".omp-execution-group-summary")?.textContent).not.toContain("3 steps");
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
