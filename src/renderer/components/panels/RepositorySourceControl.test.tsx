/**
 * Source control in the Changes panel (linkedom): staging checkboxes, the
 * commit form with stock's generated message, push/publish by upstream, the
 * stopped-merge banner and discard behind a confirmation. Each action is one
 * `rpc.command` on the tab's checkout, followed by a reload of the list.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcCommand, RpcGitChanges, RpcGitHead } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { RepositoryChanges } from "./RepositoryChanges";

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
	indeterminate: boolean;
	textContent: string | null;
	remove: () => void;
	dispatchEvent: (event: object) => boolean;
	getAttribute: (name: string) => string | null;
}

const HEAD: RpcGitHead = {
	branch: "main",
	upstream: "origin/main",
	ahead: 2,
	behind: 1,
	operation: null,
	stashes: 0,
	hasRemote: true,
};

function changes(files: RpcGitChanges["files"], head: Partial<RpcGitHead> = {}): RpcGitChanges {
	return { isRepo: true, root: "/work", base: "abc", files, truncated: false, head: { ...HEAD, ...head } };
}

let command: Mock<(cmd: RpcCommand) => Promise<unknown>>;
let getGitChanges: Mock<() => Promise<unknown>>;

function install(data: RpcGitChanges, answers: Partial<Record<string, unknown>> = {}): void {
	getGitChanges = vi.fn(async () => ({ success: true, data }));
	command = vi.fn(async (cmd: RpcCommand) => ({
		type: "response",
		command: cmd.type,
		success: true,
		data: answers[cmd.type] ?? null,
	}));
	(window as unknown as { omp: unknown }).omp = {
		rpc: { getGitChanges, getGitDiff: vi.fn(async () => ({ success: false, error: "unused" })), command },
	};
}

let container: TestElement;
let root: Root;
async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<RepositoryChanges />
			</I18nProvider>,
		);
	});
	await flush();
}

const queryAll = (selector: string) => Array.from(document.querySelectorAll(selector)) as unknown as TestElement[];
const byLabel = (label: string) => queryAll(`[aria-label="${label}"]`)[0];
const buttonByText = (text: string) => queryAll("button").find(button => button.textContent?.trim() === text);

async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}
const click = (element: TestElement) => dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
async function toggle(box: TestElement): Promise<void> {
	box.checked = !box.checked;
	await click(box);
	await flush();
}
async function type(field: TestElement, value: string): Promise<void> {
	field.value = value;
	await dispatch(field, new Event("input", { bubbles: true, cancelable: true }));
}
const sent = () => command.mock.calls.map(([cmd]) => cmd);

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	for (const node of queryAll("[role=dialog]")) node.remove();
	useToastStore.setState({ toasts: [] });
});

describe("Changes panel source control", () => {
	it("stages one file and everything through the checkboxes, then reloads", async () => {
		install(
			changes([
				{ path: "src/a.ts", status: " M" },
				{ path: "src/b.ts", status: "M " },
			]),
		);
		await mount();
		expect(document.body.textContent).toContain("1 of 2 staged");
		const unstaged = byLabel("Stage src/a.ts")!;
		expect(unstaged.checked).toBe(false);
		expect(byLabel("Unstage src/b.ts")!.checked).toBe(true);
		await toggle(unstaged);
		expect(sent()).toContainEqual({ type: "git_stage", paths: ["src/a.ts"] });
		await toggle(byLabel("Unstage src/b.ts")!);
		expect(sent()).toContainEqual({ type: "git_unstage", paths: ["src/b.ts"] });
		const all = queryAll('input[type="checkbox"]')[1]!;
		expect(all.getAttribute("aria-checked")).toBe("mixed");
		await toggle(all);
		expect(sent()).toContainEqual({ type: "git_stage", paths: "all" });
		expect(getGitChanges.mock.calls.length).toBeGreaterThanOrEqual(4);
	});

	it("commits the staged files with the typed message and fills a message from stock omp commit", async () => {
		install(changes([{ path: "src/a.ts", status: "M " }]), {
			git_commit_message: { message: "feat(a): change a\n\n- details" },
			git_commit: { sha: "abc" },
		});
		await mount();
		const submit = buttonByText("Commit 1 to main")!;
		expect(submit.disabled).toBe(true);
		await click(byLabel("Write a message from the staged changes")!);
		await flush();
		expect(sent()).toContainEqual({ type: "git_commit_message" });
		const field = byLabel("Commit message")!;
		expect(field.value).toBe("feat(a): change a\n\n- details");
		await type(field, "fix: typed");
		expect(buttonByText("Commit 1 to main")!.disabled).toBe(false);
		await click(buttonByText("Commit 1 to main")!);
		await flush();
		expect(sent()).toContainEqual({ type: "git_commit", message: "fix: typed", amend: false });
		expect(byLabel("Commit message")!.value).toBe("");
	});

	it("blocks commit and generation with nothing staged", async () => {
		install(changes([{ path: "src/a.ts", status: " M" }]));
		await mount();
		await type(byLabel("Commit message")!, "fix: x");
		expect(buttonByText("Commit 0 to main")!.disabled).toBe(true);
		expect(document.body.textContent).toContain("Stage the changes you want to commit.");
		expect(byLabel("Stage changes to write a message")!.disabled).toBe(true);
	});

	it("shows pull/push counts, and Publish for a branch without upstream", async () => {
		install(changes([{ path: "a", status: " M" }]));
		await mount();
		expect(buttonByText("Pull1")).toBeTruthy();
		await click(buttonByText("Push2")!);
		await flush();
		expect(sent()).toContainEqual({ type: "git_remote", action: "push" });
		await act(async () => root.unmount());
		install(changes([{ path: "a", status: " M" }], { upstream: null, ahead: 0, behind: 0 }));
		await mount();
		await click(buttonByText("Publish")!);
		await flush();
		expect(sent()).toContainEqual({ type: "git_remote", action: "push" });
		expect(buttonByText("Pull")!.disabled).toBe(true);
	});

	it("shows a stopped merge, keeps Continue and Commit closed while conflicts remain", async () => {
		install(changes([{ path: "README.md", status: "UU" }], { operation: "merge" }));
		await mount();
		expect(document.body.textContent).toContain("Merge in progress");
		expect(document.body.textContent).toContain("1 unresolved conflicts");
		expect(document.body.textContent).toContain("Conflict");
		expect(buttonByText("Continue")!.disabled).toBe(true);
		await type(byLabel("Commit message")!, "merge");
		expect(document.body.textContent).toContain("Resolve 1 conflicting files first.");
		await click(buttonByText("Abort")!);
		await click(queryAll("[role=dialog] button").find(button => button.textContent === "Abort")!);
		await flush();
		expect(sent()).toContainEqual({ type: "git_operation", action: "abort" });
	});

	it("discards a file only after the confirmation", async () => {
		install(changes([{ path: "src/a.ts", status: " M" }]));
		await mount();
		await click(byLabel("Discard changes in src/a.ts")!);
		expect(sent()).toEqual([]);
		expect(document.body.textContent).toContain("src/a.ts goes back to the last commit.");
		await click(queryAll("[role=dialog] button").find(button => button.textContent === "Discard changes")!);
		await flush();
		expect(sent()).toContainEqual({ type: "git_discard", paths: ["src/a.ts"] });
	});
});
