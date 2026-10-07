/**
 * WorktreeCloseDialog contract: deleting removes the checkout the tab was
 * bound to at spawn (`tab.worktree.path`), never the tab's current cwd, which
 * follows session switches and may name a different directory by then.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { WorktreeCloseDialog } from "./WorktreeCloseDialog";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

const WORKTREE_PATH = "/home/u/.omp/wt/gui-fix-1234567";
const MAIN_CHECKOUT = "/home/u/projects/app";

let container: HTMLElement | undefined;
let root: Root | undefined;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	useUiStore.setState({ worktreeClosePrompt: null });
	useTabsStore.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("WorktreeCloseDialog", () => {
	it.each([
		{ dirty: false, button: "worktreeClose.delete" as const },
		{ dirty: true, button: "worktreeClose.forceDelete" as const },
	])(
		"removes the tab's bound worktree, not the directory its session moved to (dirty: $dirty)",
		async ({ dirty, button }) => {
			const commandForTab = vi.fn(async (_tabId: string, command: RpcCommand): Promise<RpcResponse> => {
				if (command.type === "worktree_remove") {
					return { type: "response", command: command.type, success: true, data: { removed: true } };
				}
				if (command.type !== "get_git_status") {
					// Closing the tab hydrates the next one; that is not this dialog's concern.
					return { type: "response", command: command.type, success: false, error: "not under test" };
				}
				const unstaged = dirty ? 2 : 0;
				const data = { isRepo: true, branch: "omp/gui/fix", staged: 0, unstaged, untracked: 0 };
				return { type: "response", command: command.type, success: true, data };
			});
			Object.assign(window, {
				omp: {
					rpc: { commandForTab },
					tabs: {
						list: vi.fn(async () => []),
						close: vi.fn(async () => true),
						setActive: vi.fn(async () => true),
						setView: vi.fn(async () => true),
					},
				},
			});
			useTabsStore.setState({
				tabs: [
					{
						kind: "agent",
						id: "a",
						// The session switched away: the tab's cwd is no longer its worktree.
						cwd: MAIN_CHECKOUT,
						status: "ready",
						unreadDone: false,
						worktree: { name: "fix", branch: "omp/gui/fix", baseCwd: MAIN_CHECKOUT, path: WORKTREE_PATH },
					},
					{ kind: "agent", id: "b", cwd: MAIN_CHECKOUT, status: "ready", unreadDone: false },
				],
				activeTabId: "a",
			});
			useUiStore.setState({ worktreeClosePrompt: { tabId: "a" } });

			container = document.createElement("div");
			document.body.appendChild(container);
			const mounted = createRoot(container);
			root = mounted;
			await act(async () => {
				mounted.render(
					<I18nProvider>
						<WorktreeCloseDialog />
					</I18nProvider>,
				);
			});
			await flush();

			const deleteButton = Array.from(document.querySelectorAll("button")).find(candidate =>
				candidate.textContent?.includes(translate(button)),
			);
			expect(deleteButton).toBeDefined();
			const click = new Event("click", { bubbles: true, cancelable: true });
			// linkedom's Event has a getter-only eventPhase React writes to.
			Object.defineProperty(click, "eventPhase", { value: 0, writable: true, configurable: true });
			await act(async () => {
				deleteButton?.dispatchEvent(click);
			});
			await flush();

			const removals = commandForTab.mock.calls.filter(([, command]) => command.type === "worktree_remove");
			expect(removals.map(([, command]) => command)).toEqual([
				{ type: "worktree_remove", path: WORKTREE_PATH, force: dirty },
			]);
		},
	);
});
