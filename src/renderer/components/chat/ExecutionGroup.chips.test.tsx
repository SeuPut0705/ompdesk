import { parseHTML } from "linkedom";
import { act, type ComponentProps, useState } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECKOUT_REFUSAL_PREFIX } from "../../../../resources/gui-bridge/modes/checkout-peers-contracts";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { buildHistoryRows } from "./chat-stream-utils";

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

/** What a transcript row hands the card besides its calls. */
type CardExtra = Pick<ComponentProps<typeof ExecutionGroup>, "notes" | "leadingSkills">;

/** The card with its own open state, and a body holding one tool card per call id. */
function Card({ ids, live = false, extra }: { ids: string[]; live?: boolean; extra?: CardExtra }) {
	const [expanded, setExpanded] = useState(false);
	return (
		<I18nProvider>
			<ExecutionGroup
				{...extra}
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

async function mount(entries: [string, ToolEntry][], live = false, extra?: CardExtra) {
	useToolsStore.setState(toolEntriesState(entries));
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<Card extra={extra} ids={entries.map(([id]) => id)} live={live} />));
}

const chip = (name: string) =>
	container.querySelector(`[data-work-finding="${name}"]`) as unknown as HTMLElement | null;
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
		// The ✓ is decorative: the chip's name says the tests passed.
		expect(chip("tests")?.getAttribute("aria-label")).toBe("128 tests passed");
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
		expect(chip("error")?.querySelector(".omp-work-verdict-label")?.textContent).toBe("1 test failed");
		expect(chip("error")?.querySelector(".omp-work-verdict-cause")?.textContent).toBe("FAIL src/a.test.ts");
		expect(chip("error")?.querySelector(".omp-work-verdict-meta")?.textContent).toBe("exit 1");
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
				"eval-1",
				{
					toolName: "eval",
					args: { language: "py", code: "1 / 0" },
					status: "error",
					streamingArgs: "",
					result: { content: [{ type: "text", text: "ZeroDivisionError" }] },
					isError: true,
					startTime: 0,
					endTime: 1,
				},
			],
		]);
		expect(chip("error")?.textContent).toBe("Error");
		expect(container.querySelector(".omp-work-verdict-cause")).toBeNull();
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

describe("what the run leaned on", () => {
	const read = (path: string, at: number): ToolEntry => ({
		toolName: "read",
		args: { path },
		status: "done",
		streamingArgs: "",
		result: { content: [{ type: "text", text: "# skill" }] },
		isError: false,
		startTime: at,
		endTime: at + 100,
	});

	afterEach(() => useSessionStore.setState({ cwd: "", checkoutPeers: null }));

	it("names the skills it read, and the chip opens the steps at the first read", async () => {
		Object.assign(HTMLElement.prototype, { scrollIntoView: vi.fn() });
		await mount([
			["skill-1", read("skill://how", 0)],
			["skill-2", read("skill://tdd/SKILL.md", 100)],
			["edit-1", edit],
		]);
		expect(chip("skills")?.textContent).toBe("how+1");
		expect(chip("skills")?.getAttribute("aria-label")).toBe("Skills used: how, tdd");
		await click(chip("skills"));
		await wait(120);
		const first = container.querySelector('[data-tool-call-id="skill-1"]') as unknown as HTMLElement;
		expect(first.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
	});

	it("says which changed files a live session in the same worktree also changed", async () => {
		useSessionStore.setState({
			cwd: "/w",
			checkoutPeers: {
				toplevel: "/w",
				commonDir: "/w/.git",
				canMessage: true,
				worktree: [
					{ id: "t2", title: "Login rename", task: "Rename the login export", files: ["/w/src/a.ts", "/w/b.ts"] },
					{ id: "t3", title: "Docs", files: ["/w/README.md"] },
				],
				repo: [{ id: "t4", title: "Elsewhere", worktree: "/wt/x" }],
			},
		});
		await mount([["edit-1", edit]]);
		expect(chip("overlap")?.textContent).toBe("Shared1");
		expect(chip("overlap")?.getAttribute("aria-label")).toBe("1 file another session also changed");
		expect(chip("overlap")?.getAttribute("title")).toBe("Login rename · Rename the login export: a.ts");
	});

	it("draws no overlap chip when no peer touched the run's files", async () => {
		useSessionStore.setState({
			cwd: "/w",
			checkoutPeers: {
				toplevel: "/w",
				commonDir: "/w/.git",
				canMessage: true,
				worktree: [{ id: "t3", title: "Docs", files: ["/w/README.md"] }],
				repo: [],
			},
		});
		await mount([["edit-1", edit]]);
		expect(chip("overlap")).toBeNull();
		expect(chip("skills")).toBeNull();
	});

	it("counts a skill read by its SKILL.md path, under any skills root, with the folder's name", async () => {
		await mount([
			["skill-1", read("/Users/me/.claude/skills/tdd/SKILL.md", 0)],
			["skill-2", read(".omp/skills/review/SKILL.md", 100)],
			["skill-3", read("skill://tdd", 200)],
		]);
		expect(chip("skills")?.textContent).toBe("tdd+1");
		expect(chip("skills")?.getAttribute("aria-label")).toBe("Skills used: tdd, review");
	});

	it("counts the skills its notes carry, once each, before the ones it read", async () => {
		const injected = (name: string): AgentMessage => ({
			role: "custom",
			customType: "skill-prompt",
			content: "Skill instructions",
			display: true,
			details: { name },
			timestamp: 50,
		});
		await mount(
			[
				["skill-1", read("skill://how", 0)],
				["edit-1", edit],
			],
			false,
			{
				notes: [injected("review"), injected("how")],
			},
		);
		expect(chip("skills")?.getAttribute("aria-label")).toBe("Skills used: review, how");
	});

	it("shows the skill a /skill: prompt started the run with, though the run read none", async () => {
		const prompt: AgentMessage = {
			role: "custom",
			customType: "skill-prompt",
			content: "Skill instructions",
			display: true,
			attribution: "user",
			details: { name: "release" },
			timestamp: 1,
		};
		const call: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/a.ts" } }],
			stopReason: "toolUse",
			timestamp: 2,
		};
		const answer: AgentMessage = { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 3 };
		const work = buildHistoryRows([prompt, call, answer], "compact").find(row => row.kind === "process");
		if (work?.kind !== "process") throw new Error("expected a work row");
		await mount(
			work.toolCallIds.map(id => [id, edit] as [string, ToolEntry]),
			false,
			{ leadingSkills: work.skills },
		);
		expect(chip("skills")?.textContent).toBe("release");
		expect(chip("skills")?.getAttribute("aria-label")).toBe("Skills used: release");
	});

	it("names a peer in another worktree whose files meet the run's, marked as such", async () => {
		useSessionStore.setState({
			cwd: "/w",
			checkoutPeers: {
				toplevel: "/w",
				commonDir: "/w/.git",
				canMessage: true,
				worktree: [],
				repo: [{ id: "t4", title: "Release notes", worktree: "/wt/x", files: ["/w/src/a.ts"] }],
			},
		});
		await mount([["edit-1", edit]]);
		expect(chip("overlap")?.textContent).toBe("Shared1");
		expect(chip("overlap")?.getAttribute("title")).toBe("Release notes (other worktree): a.ts");
	});
});

describe("calls the shared-checkout guard refused", () => {
	const refused = (toolName: string, args: Record<string, unknown>, what: string, at: number): ToolEntry => ({
		toolName,
		args,
		status: "error",
		streamingArgs: "",
		result: {
			content: [{ type: "text", text: `${CHECKOUT_REFUSAL_PREFIX}: ${what}.\nSettings test race changed it.` }],
		},
		isError: true,
		startTime: at,
		endTime: at + 10,
	});
	const refusedWrite = refused(
		"write",
		{ path: "src/b.ts", content: "x" },
		"writing src/b.ts whole would drop changes",
		600,
	);
	const refusedPush = refused("bash", { command: "git stash" }, "`git stash`: stashing hides their work", 700);
	const section = () => container.querySelector(".omp-execution-group") as unknown as HTMLElement;

	it.each([
		["write", refusedWrite, "writing src/b.ts whole would drop changes"],
		["bash", refusedPush, "`git stash`: stashing hides their work"],
	])("a refused %s is a Protected chip, never a failure, and a tap shows that step", async (_, entry, what) => {
		Object.assign(HTMLElement.prototype, { scrollIntoView: vi.fn() });
		await mount([
			["edit-1", edit],
			["refused-1", entry],
		]);
		expect(section().getAttribute("data-state")).toBe("complete");
		expect(section().getAttribute("data-verdict")).toBeNull();
		expect(container.querySelector('[data-work-finding="error"]')).toBeNull();
		expect(chip("protected")?.textContent).toBe("Protected1");
		expect(chip("protected")?.getAttribute("aria-label")).toBe("1 step held back to protect other sessions' work");
		expect(chip("protected")?.getAttribute("title")).toBe(what);
		await click(chip("protected"));
		await wait(120);
		const step = container.querySelector('[data-tool-call-id="refused-1"]') as unknown as HTMLElement;
		expect(step.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
	});

	it("lists each refusal on its own line of the tooltip", async () => {
		await mount([
			["refused-1", refusedWrite],
			["refused-2", refusedPush],
		]);
		expect(chip("protected")?.textContent).toBe("Protected2");
		expect(chip("protected")?.getAttribute("title")).toBe(
			"writing src/b.ts whole would drop changes\n`git stash`: stashing hides their work",
		);
	});

	it("still marks a write that failed on its own red, and shows no Protected chip for it", async () => {
		const broken: ToolEntry = {
			...refusedWrite,
			result: { content: [{ type: "text", text: "EACCES: permission denied, open 'src/b.ts'" }] },
		};
		await mount([
			["edit-1", edit],
			["broken-1", broken],
		]);
		expect(section().getAttribute("data-state")).toBe("failed");
		expect(container.querySelector('[data-work-finding="error"]')).not.toBeNull();
		expect(chip("protected")).toBeNull();
	});
});
