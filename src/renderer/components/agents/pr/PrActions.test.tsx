/**
 * PR Center actions (linkedom): merge with a chosen method after the dialog,
 * no merge for a closed PR, the conversation list, and review/comment posts.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcCommand, RpcPrComments, RpcPrDetail } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { usePrCenterStore } from "../../../stores/pr-center";
import { useToastStore } from "../../../stores/toast";
import { PrConversation, PrMergeButton } from "./PrActions";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

// react-dom must load after linkedom's globals above, so this import cannot be static.
const { createRoot } = await import("react-dom/client");

interface TestElement {
	disabled: boolean;
	checked: boolean;
	value: string;
	textContent: string | null;
	remove: () => void;
	dispatchEvent: (event: object) => boolean;
	getAttribute: (name: string) => string | null;
}

const DETAIL: RpcPrDetail = {
	number: 7,
	title: "Add a thing",
	url: "https://github.com/o/r/pull/7",
	isDraft: false,
	authorLogin: "me",
	body: "",
	baseRefName: "main",
	headRefName: "feat/thing",
	mergeStateStatus: "CLEAN",
	state: "OPEN",
	additions: 1,
	deletions: 0,
	reviewDecision: null,
	files: [],
	checks: [],
};

const COMMENTS: RpcPrComments = {
	entries: [
		{ kind: "comment", author: "alice", body: "Looks fine", createdAt: "2026-10-01T00:00:00Z" },
		{ kind: "review", author: "bob", body: "", createdAt: "2026-10-02T00:00:00Z", state: "APPROVED" },
		{ kind: "inline", author: "carol", body: "nit", createdAt: "2026-10-03T00:00:00Z", path: "a.ts", line: 3 },
	],
};

let command: Mock<(cmd: RpcCommand) => Promise<unknown>>;
let root: Root;
let container: TestElement;

function install(): void {
	command = vi.fn(async (cmd: RpcCommand) => ({
		type: "response",
		command: cmd.type,
		success: true,
		data: cmd.type === "pr_comments" ? COMMENTS : {},
	}));
	(window as unknown as { omp: unknown }).omp = {
		rpc: {
			command,
			prList: vi.fn(async () => ({ success: true, data: [] })),
			prGet: vi.fn(async () => ({ success: true, data: DETAIL })),
		},
	};
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(node: React.ReactNode): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{node}</I18nProvider>);
	});
	await flush();
}

const queryAll = (selector: string) => Array.from(document.querySelectorAll(selector)) as unknown as TestElement[];
const buttonByText = (text: string, scope = "") =>
	queryAll(`${scope} button`).find(button => button.textContent?.trim() === text);
async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}
const click = (element: TestElement) => dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
const sent = () => command.mock.calls.map(([cmd]) => cmd);

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	for (const node of queryAll("[role=dialog]")) node.remove();
	usePrCenterStore.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("PR Center actions", () => {
	it("merges with the chosen method and deletes the head branch on GitHub", async () => {
		install();
		usePrCenterStore.setState({ selected: 7 });
		await mount(<PrMergeButton detail={DETAIL} />);
		await click(buttonByText("Merge")!);
		// linkedom's <select> value is read-only: drive the controlled select's React onChange.
		const select = queryAll("[role=dialog] select")[0] as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(select).find(key => key.startsWith("__reactProps$"));
		const props = propsKey ? (select[propsKey] as { onChange?: (event: object) => void }) : undefined;
		await act(async () => props?.onChange?.({ target: { value: "squash" } }));
		await click(buttonByText("Squash and merge", "[role=dialog]")!);
		await flush();
		expect(sent()).toContainEqual({ type: "pr_merge", number: 7, method: "squash", deleteBranch: true });
		expect(useToastStore.getState().toasts.map(toast => toast.message)).toContain("PR #7 merged");
	});

	it("offers no merge on a merged pull request", async () => {
		install();
		await mount(<PrMergeButton detail={{ ...DETAIL, state: "MERGED" }} />);
		expect(buttonByText("Merge")).toBeUndefined();
	});

	it("lists the conversation and posts an approval", async () => {
		install();
		await mount(<PrConversation detail={DETAIL} />);
		expect(sent()).toContainEqual({ type: "pr_comments", number: 7 });
		const text = document.body.textContent ?? "";
		expect(text).toContain("Conversation (3)");
		expect(text).toContain("@alice");
		expect(text).toContain("Approved");
		expect(text).toContain("a.ts:3");
		expect(buttonByText("Comment")!.disabled).toBe(true);
		await click(buttonByText("Approve")!);
		await flush();
		expect(sent()).toContainEqual({ type: "pr_review", number: 7, event: "approve", body: "" });
	});
});
