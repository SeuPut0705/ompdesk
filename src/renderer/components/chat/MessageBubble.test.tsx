import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { wrapAgentMessage } from "../../../shared/agent-control";
import type { AgentMessage } from "../../../shared/rpc-types";
import { resetShellModeForTests, TOUCH_QUERY } from "../../hooks/use-shell-mode";
import { I18nProvider } from "../../lib/i18n";
import { preloadMarkdownPipeline } from "../../lib/markdown";
import { useToolsStore } from "../../stores/tools";

import { CustomMessageCard } from "./CustomMessageCard";
import { MessageBubble } from "./MessageBubble";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
// renderToStaticMarkup never runs effects: load the lazy KaTeX/raw-HTML steps first so
// "no KaTeX for literal dollars" is asserted against the real pipeline.
beforeAll(() => preloadMarkdownPipeline());

const toolCallId = "call_read_package";
const assistantMessage: AgentMessage = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: toolCallId,
			name: "read",
			arguments: { path: "packages/gui/package.json" },
		},
	],
	timestamp: "2026-08-02T12:00:00.000Z",
};
const toolResultMessage: AgentMessage = {
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [{ type: "text", text: '{"name":"@oh-my-pi/omp-gui"}' }],
	isError: false,
	timestamp: "2026-08-02T12:00:01.000Z",
};

afterEach(() => {
	useToolsStore.getState().reset();
});

describe("MessageBubble tool messages", () => {
	it("hydrates a completed tool card and folds away the standalone result", () => {
		useToolsStore.getState().hydrateMessages([assistantMessage, toolResultMessage]);

		const entry = useToolsStore.getState().finishedTools.get(toolCallId);
		expect(entry).toMatchObject({
			toolName: "read",
			args: { path: "packages/gui/package.json" },
			status: "done",
			isError: false,
		});

		const callHtml = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble message={assistantMessage} />
			</I18nProvider>,
		);
		// A human label and the file name lead the row; the full path rides the tooltip.
		expect(callHtml).toContain(">Read<");
		expect(callHtml).toContain(">package.json<");
		expect(callHtml).toContain("packages/gui/package.json");
		expect(
			renderToStaticMarkup(
				<I18nProvider>
					<MessageBubble message={toolResultMessage} />
				</I18nProvider>,
			),
		).toBe("");
	});

	it("shows edited files for freeform edit calls in collapsed headers", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_edit_patch",
					name: "edit",
					arguments: {
						input: "*** Begin Patch\n[packages/gui/src/first.ts#A1B2] PUT 1.=1:\n+first\n[packages/gui/src/second.ts#C3D4] PUT 1.=1:\n+second\n*** End Patch\n",
					},
				},
			],
			timestamp: "2026-08-12T00:00:00.000Z",
		};
		useToolsStore.getState().hydrateMessages([message]);

		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble message={message} />
			</I18nProvider>,
		);
		expect(html).toContain("packages/gui/src/first.ts +1");
	});

	it("keeps repeated provider call ids paired with their own historical results", async () => {
		const firstCall: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "read:0", name: "read", arguments: { path: "first.txt" } }],
			timestamp: "2026-08-02T12:00:02.000Z",
		};
		const firstResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "read:0",
			toolName: "read",
			content: [{ type: "text", text: "FIRST_RESULT" }],
			timestamp: "2026-08-02T12:00:03.000Z",
		};
		const secondCall: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "read:0", name: "read", arguments: { path: "second.txt" } }],
			timestamp: "2026-08-02T12:00:04.000Z",
		};
		const secondResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "read:0",
			toolName: "read",
			content: [{ type: "text", text: "SECOND_RESULT" }],
			timestamp: "2026-08-02T12:00:05.000Z",
		};
		useToolsStore.getState().hydrateMessages([firstCall, firstResult, secondCall, secondResult]);
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<I18nProvider>
						<div id="first-call">
							<MessageBubble message={firstCall} />
						</div>
						<div id="second-call">
							<MessageBubble message={secondCall} />
						</div>
					</I18nProvider>,
				);
			});
			const firstNode = container.querySelector("#first-call");
			const secondNode = container.querySelector("#second-call");
			const firstButton = firstNode?.querySelector("button");
			const secondButton = secondNode?.querySelector("button");
			if (!firstNode || !secondNode || !firstButton || !secondButton) throw new Error("tool cards did not render");
			await act(async () => firstButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
			await act(async () => secondButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
			expect(firstNode.textContent).toContain("FIRST_RESULT");
			expect(firstNode.textContent).not.toContain("SECOND_RESULT");
			expect(secondNode.textContent).toContain("SECOND_RESULT");
			expect(secondNode.textContent).not.toContain("FIRST_RESULT");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});

describe("MessageBubble user executions", () => {
	it.each([
		["bashExecution", { command: "sleep 60" }, "abort_bash"],
		["pythonExecution", { code: "while True: pass" }, "abort_eval"],
	] as const)("Cancel on a running %s stops it with %s", async (role, input, expected) => {
		const sent: string[] = [];
		// linkedom's window has no preload bridge; the card reaches its rpc through `window.omp`.
		const ompWindow: { omp?: unknown } = window;
		ompWindow.omp = {
			rpc: {
				abortBash: async () => {
					sent.push("abort_bash");
					return { type: "response", command: "abort_bash", success: true };
				},
				abortEval: async () => {
					sent.push("abort_eval");
					return { type: "response", command: "abort_eval", success: true };
				},
			},
		};
		const message = { role, ...input, running: true, timestamp: "2026-10-14T12:00:00.000Z" } as AgentMessage;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<I18nProvider>
						<MessageBubble message={message} />
					</I18nProvider>,
				),
			);
			const cancel = Array.from(container.querySelectorAll("button")).find(button =>
				button.textContent?.includes("Cancel"),
			);
			if (!cancel) throw new Error("running execution has no Cancel");
			await act(async () => cancel.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
			expect(sent).toEqual([expected]);
		} finally {
			await act(async () => root.unmount());
			container.remove();
			delete ompWindow.omp;
		}
	});
});

describe("MessageBubble user content", () => {
	it("shows an assistant reaction on the user bubble", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [{ type: "text", text: "Ship it?" }],
						timestamp: "2026-08-06T00:00:00.000Z",
					}}
					reaction="👍"
				/>
			</I18nProvider>,
		);
		expect(html).toContain('role="img"');
		expect(html).toContain("👍");
	});

	it("names the device a prompt came from when the bridge labelled it (A85)", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [{ type: "text", text: "Ship it?" }],
						timestamp: "2026-08-06T00:00:00.000Z",
						promptFrom: "Laptop A",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("data-prompt-from");
		expect(html).toContain("from Laptop A");
	});

	it("shows another agent's message as its body with a sent-by label, not the wrapper", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [{ type: "text", text: wrapAgentMessage("Please run the **tests**", "Fix login") }],
						timestamp: "2026-08-06T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("data-agent-sent");
		expect(html).toContain("Sent by an agent · Fix login");
		expect(html).toContain("<strong>tests</strong>");
		expect(html).not.toContain("ompdesk-agent-message");
	});

	it("labels an agent message from an untitled session without a name", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [{ type: "text", text: wrapAgentMessage("hello", "") }],
						timestamp: "2026-08-06T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("data-agent-sent");
		expect(html).not.toContain("·");
	});

	it("leaves a person's own prompt unlabelled", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [{ type: "text", text: "Ship it?" }],
						timestamp: "2026-08-06T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).not.toContain("data-agent-sent");
		expect(html).toContain("Ship it?");
	});

	it("renders user text through the same Markdown pipeline as assistant text", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [{ type: "text", text: "**bold** and `code`" }],
						timestamp: "2026-08-06T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<code");
	});

	it("keeps SQL JSONPath dollars literal instead of parsing them as inline math", () => {
		const sql =
			"JSON_SET(o.parameters, '$.reasoning_effort.required', FALSE, '$.reasoning_effort.default', 'medium')";
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [{ type: "text", text: sql }],
						timestamp: "2026-08-13T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("$.reasoning_effort.required");
		expect(html).toContain("$.reasoning_effort.default");
		expect(html).not.toContain("katex");
	});
});

describe("MessageBubble compaction summaries", () => {
	it("shows the maintenance method and before-to-after context size", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "compactionSummary",
						summary: "Long archived context details.",
						shortSummary: "Kept the active work.",
						method: "remote",
						tokensBefore: 256_000,
						tokensAfter: 20_000,
						timestamp: "2026-08-20T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);

		expect(html).toContain("Remote compacted · 256.0k → 20.0k");
		expect(html).toContain("Kept the active work.");
		expect(html).not.toContain("Long archived context details.");
	});

	it("preserves an unknown maintenance method and a zero-token starting point", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "compactionSummary",
						summary: "Future compactor finished.",
						method: "future",
						tokensBefore: 0,
						tokensAfter: 12,
						timestamp: "2026-08-20T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);

		expect(html).toContain("future · 0 → 12");
	});

	it("opens the full summary from a chevron disclosure button", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<I18nProvider>
					<MessageBubble
						message={{
							role: "compactionSummary",
							summary: "Long archived context details.",
							shortSummary: "Kept the active work.",
							timestamp: "2026-08-20T00:00:00.000Z",
						}}
					/>
				</I18nProvider>,
			),
		);
		const toggle = container.querySelector("button[aria-expanded]");
		expect(toggle?.textContent).toBe("View context details");
		expect(toggle?.querySelector(".omp-disclosure-chevron")).not.toBeNull();
		expect(container.querySelector("details")).toBeNull();
		await act(async () => toggle?.dispatchEvent(new Event("click", { bubbles: true })));
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		expect(container.textContent).toContain("Long archived context details.");
		await act(async () => root.unmount());
		container.remove();
	});

	it("shows a branch summary's text in the card", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "branchSummary",
						summary: "Tried the thumbprint cache; dropped it.",
						timestamp: "2026-08-20T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("Branch summary");
		expect(html).toContain("Tried the thumbprint cache; dropped it.");
		expect(html).not.toContain("View context details");
	});
});

describe("MessageBubble completion events", () => {
	// Inside a work run the card is a note: WorkNotes renders it through CustomMessageCard inProcess.
	it("renders supervised-process failures inside a run as one compact status row without the wire type", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<CustomMessageCard
					inProcess
					message={{
						role: "custom",
						customType: "launch-completion",
						content: "Supervised process backend-smoke failed with exit code 1.",
						details: {
							daemons: [{ name: "backend-smoke", state: "failed", exitCode: 1 }],
						},
						display: true,
						timestamp: "2026-08-20T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("backend-smoke");
		expect(html).toContain("exit 1");
		expect(html).not.toContain("launch-completion");
		expect(html).not.toContain("omp-custom-turn");
	});

	it("keeps background output behind one native disclosure row", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "custom",
						customType: "async-result",
						content: "<system-notice>Background job bg-7 has completed.\nBUILD_OUTPUT</system-notice>",
						details: { jobs: [{ jobId: "bg-7", type: "bash", label: "bun run build" }] },
						display: true,
						timestamp: "2026-08-20T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("bun run build");
		expect(html).toContain("Background job completed");
		expect(html).toContain("<details");
		expect(html).not.toContain("<details open");
		expect(html).toContain("BUILD_OUTPUT");
	});
});

describe("MessageBubble restart notice", () => {
	const notice = (details: unknown): AgentMessage => ({
		role: "custom",
		customType: "ompdesk-restart-jobs",
		content:
			"OMPdesk restarted and stopped these background jobs before they finished; their results will not arrive:\n- bg_394: Watch release CI — `gh run watch 39044075209 --exit-status`\nStart again, in the background, only the jobs the work still needs.",
		details,
		display: true,
		attribution: "agent",
		timestamp: "2026-10-17T15:25:30.000Z",
	});
	const render = (message: AgentMessage) =>
		renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble message={message} />
			</I18nProvider>,
		);

	it("is one small muted system line: the count and the intents on hover, never a user bubble or a command", () => {
		const html = render(
			notice({
				jobs: [{ id: "bg_394", intent: "Watch release CI" }, { id: "bg_395" }],
			}),
		);
		expect(html).toContain("data-restart-jobs");
		expect(html).toContain("Re-running 2 background task(s) the restart stopped");
		expect(html).toContain('title="Watch release CI"');
		expect(html).not.toContain("omp-user-bubble");
		expect(html).not.toContain("omp-user-turn");
		expect(html).not.toContain("gh run watch");
		expect(html).not.toContain("OMPdesk restarted");
		expect(html).not.toContain("ompdesk-restart-jobs");
	});

	it("says one task for a notice with no details, and stays hidden when the message is not displayed", () => {
		expect(render(notice(undefined))).toContain("Re-running 1 background task(s)");
		expect(render({ ...notice(undefined), display: false })).toBe("");
	});
});

describe("MessageBubble noise filtering", () => {
	const at = "2026-08-02T12:00:00.000Z";

	it('renders nothing for punctuation-only text or thinking blocks (model filler like ".")', () => {
		for (const text of [".", "…", "---", " ", "***"]) {
			for (const message of [
				{ role: "assistant" as const, content: [{ type: "text" as const, text }], timestamp: at },
				{ role: "assistant" as const, content: [{ type: "thinking" as const, thinking: text }], timestamp: at },
			]) {
				expect(
					renderToStaticMarkup(
						<I18nProvider>
							<MessageBubble message={message} />
						</I18nProvider>,
					),
				).toBe("");
			}
		}
	});

	it("keeps real text, CJK, and emoji-only blocks", () => {
		for (const text of ["已修复", "Done.", "👍"]) {
			const message: AgentMessage = { role: "assistant", content: [{ type: "text", text }], timestamp: at };
			expect(
				renderToStaticMarkup(
					<I18nProvider>
						<MessageBubble message={message} />
					</I18nProvider>,
				),
			).toContain(text);
		}
	});

	it("compacts tool-only messages — no hover footer chrome", () => {
		useToolsStore.getState().hydrateMessages([assistantMessage, toolResultMessage]);
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble message={assistantMessage} />
			</I18nProvider>,
		);
		// The timestamp/copy/branch footer is message-level chrome a tool card
		// doesn't need (copy would copy an empty string).
		expect(html).not.toContain("Copy message text");
		expect(html).toContain("py-1.5");
	});

	it("keeps the footer on text-bearing messages", () => {
		const mixed: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Fixed." },
				{ type: "toolCall", id: "call_mixed", name: "read", arguments: { path: "x" } },
			],
			timestamp: at,
		};
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble message={mixed} />
			</I18nProvider>,
		);
		expect(html).toContain("Fixed.");
		expect(html).toContain("Copy message text");
		expect(html).toContain("py-3");
	});

	it("offers branch-to-new-tab on user and assistant messages even before legacy ids are resolved", () => {
		const user: AgentMessage = {
			role: "user",
			entryId: "user-entry",
			content: [{ type: "text", text: "branch point" }],
			timestamp: at,
		};
		const assistant: AgentMessage = {
			role: "assistant",
			entryId: "assistant-entry",
			content: [{ type: "text", text: "answer" }],
			timestamp: at,
		};
		const render = (message: AgentMessage) =>
			renderToStaticMarkup(
				<I18nProvider>
					<MessageBubble message={message} />
				</I18nProvider>,
			);

		expect(render(user)).toContain("Branch to a new tab from here");
		expect(render(assistant)).toContain("Branch to a new tab from here");
		expect(render({ ...assistant, entryId: undefined })).toContain("Branch to a new tab from here");
	});

	it("uses compact chrome for expanded process details containing reasoning and tools", () => {
		const processMessage: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Inspect first." },
				{ type: "toolCall", id: "call_process", name: "read", arguments: { path: "x" } },
			],
			timestamp: at,
		};
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble compact message={processMessage} />
			</I18nProvider>,
		);
		expect(html).toContain(">Read<");
		expect(html).not.toContain("Copy message text");
		expect(html).toContain("py-1.5");
		expect(html).toContain("omp-assistant-turn--compact");
	});

	it("uses the full-width transcript content surface for assistant output", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "assistant",
						content: [{ type: "text", text: "A long answer that must follow the transcript reading measure." }],
						timestamp: at,
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain('class="omp-transcript-content min-w-0"');
		expect(html).not.toContain('class="min-w-0 flex-1"');
	});

	it("renders a user stop as a neutral note, never an error card", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "assistant",
						content: [{ type: "text", text: "Partial answer" }],
						stopReason: "error",
						errorMessage: "Request was aborted",
						timestamp: at,
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("omp-turn-stopped");
		expect(html).toContain("Stopped");
		expect(html).not.toContain("omp-message-error");
		expect(html).not.toContain('role="alert"');
	});

	it("shows no notice for stock's silent abort, like stock", () => {
		const silent = (content: AgentMessage["content"]) =>
			renderToStaticMarkup(
				<I18nProvider>
					<MessageBubble
						message={{
							role: "assistant",
							content,
							stopReason: "aborted",
							errorMessage: "__omp.silent_abort__",
							timestamp: at,
						}}
					/>
				</I18nProvider>,
			);
		expect(silent([])).toBe("");
		const html = silent([{ type: "text", text: "Plan ready for review" }]);
		expect(html).toContain("Plan ready for review");
		expect(html).not.toContain("omp-turn-stopped");
		expect(html).not.toContain('role="alert"');
	});

	it("explains a failure in plain words with recovery actions and keeps the raw text as detail", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: "Unable to connect. Is the computer able to access the url?",
						timestamp: at,
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("omp-message-error");
		expect(html).toContain("Can&#x27;t connect");
		expect(html).toContain("Try again");
		expect(html).toContain("Open providers");
		expect(html).toContain("<details");
		expect(html).toContain("Unable to connect. Is the computer able to access the url?");
	});

	it("offers compaction for a context overflow", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: "Prompt is too long: Provided 8,464 tokens, but the maximum allowed is 8,192.",
						timestamp: at,
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("Compact context");
		expect(html).toContain("Change model");
	});

	it("keeps an idle user turn exactly its text: no author label, actions overlaid", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{ role: "user", content: [{ type: "text", text: "Fix the build" }], timestamp: at }}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("omp-user-bubble");
		expect(html).not.toContain(">You<");
		expect(html).toContain("omp-user-actions");
		expect(html).toContain("Copy message text");
	});
});

describe("MessageBubble on a touch screen", () => {
	afterEach(() => {
		delete document.documentElement.dataset.platform;
		Object.assign(window, { matchMedia: undefined });
		resetShellModeForTests();
	});

	// Reported on v0.35.1: a scroll-stop tap under a tapped prompt hit its revealed Branch button and opened a
	// branch tab nobody asked for. On touch Branch sits in the row's ⋯ menu, never directly under a tap.
	it("puts Branch in the ⋯ menu instead of a direct button", async () => {
		document.documentElement.dataset.platform = "web";
		Object.assign(window, {
			matchMedia: (query: string) => ({
				matches: query === TOUCH_QUERY,
				addEventListener: () => {},
				removeEventListener: () => {},
			}),
		});
		resetShellModeForTests();
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<I18nProvider>
						<MessageBubble message={{ role: "user", content: "a prompt", timestamp: 1 }} />
					</I18nProvider>,
				);
			});
			expect(container.querySelector("button[aria-label='Branch to a new tab from here']")).toBeNull();
			const more = container.querySelector(".omp-message-actions button[aria-haspopup='menu']");
			expect(more?.getAttribute("aria-label")).toBe("More");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});

describe("MessageBubble attached images", () => {
	it("draws attached bytes and shows a collected blob or empty data as a chip, never a broken data URL", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [
							{ type: "text", text: "Look at these" },
							{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
							// Stock left the reference: its blob is gone from the store.
							{ type: "image", data: `blob:sha256:${"0".repeat(64)}`, mimeType: "image/png" },
							{ type: "image", data: "", mimeType: "image/png" },
						],
						timestamp: "2026-08-02T12:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		const sources = [...html.matchAll(/<img[^>]*src="([^"]*)"/g)].map(match => match[1]);
		expect(sources).toEqual(["data:image/png;base64,iVBORw0KGgo="]);
		expect(html).not.toContain("blob:sha256:");
		expect(html.match(/data-image-unavailable/g)).toHaveLength(2);
	});
});
