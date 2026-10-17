/**
 * WorktreeDialog: the branch it previews and asks for carries the Worktree branch prefix from Settings
 * (`worktreeBranchPrefix`), else omp/gui/.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionRpcClient } from "../../../shared/rpc-client";
import type { RpcCommand, RpcResponse } from "../../../shared/rpc-types";
import { WORKTREE_BRANCH_PREFIX_PREF } from "../../../shared/worktree-branch";
import { I18nProvider, translate } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { WorktreeDialog } from "./WorktreeDialog";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	CustomEvent,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

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
	useUiStore.getState().closeWorktreeDialog();
	useTabsStore.getState().reset();
});

/** The props React gave an element (linkedom has no input events of its own). */
function reactProps(element: Element): Record<string, (event: object) => void> {
	const key = Object.keys(element).find(name => name.startsWith("__reactProps$"));
	return key ? (element as unknown as Record<string, Record<string, (event: object) => void>>)[key] : {};
}
async function mount(prefix: unknown) {
	const commands: RpcCommand[] = [];
	const rpc = createSessionRpcClient(async (command: RpcCommand): Promise<RpcResponse> => {
		commands.push(command);
		return { type: "response", command: command.type, success: false, error: "not under test" };
	});
	Object.assign(window, {
		omp: {
			rpc,
			prefs: { get: vi.fn(async (key: string) => (key === WORKTREE_BRANCH_PREFIX_PREF ? prefix : undefined)) },
		},
	});
	useTabsStore.setState({
		tabs: [{ kind: "agent", id: "a", cwd: "/home/u/app", status: "ready", unreadDone: false }],
		activeTabId: "a",
	});
	useSessionStore.setState({ status: "ready", cwd: "/home/u/app" });
	useUiStore.getState().openWorktreeDialog();
	container = document.createElement("div");
	document.body.appendChild(container);
	const mounted = createRoot(container);
	root = mounted;
	await act(async () => {
		mounted.render(
			<I18nProvider>
				<WorktreeDialog />
			</I18nProvider>,
		);
	});
	await flush();
	return { commands };
}

async function typeName(value: string): Promise<void> {
	const input = document.querySelector("input:not([type=radio])");
	if (!input) throw new Error("no name field");
	await act(async () => reactProps(input).onChange?.({ target: { value } }));
	await flush();
}

async function submit(): Promise<void> {
	const form = document.querySelector("form");
	if (!form) throw new Error("no form");
	await act(async () => reactProps(form).onSubmit?.({ preventDefault: () => {} }));
	await flush();
}

describe("WorktreeDialog branch prefix", () => {
	it("previews and creates the branch under the prefix set in Settings", async () => {
		const { commands } = await mount("alice/");
		await typeName("Login");
		expect(document.body.textContent).toContain(translate("worktree.branchPreview", { branch: "alice/login" }));
		await submit();
		expect(commands.filter(command => command.type === "worktree_create")).toEqual([
			{ type: "worktree_create", name: "Login", baseCwd: "/home/u/app", baseRef: "HEAD", branchPrefix: "alice/" },
		]);
	});

	it("falls back to omp/gui/ when no prefix is set, and sends none", async () => {
		const { commands } = await mount(undefined);
		await typeName("Login");
		expect(document.body.textContent).toContain(translate("worktree.branchPreview", { branch: "omp/gui/login" }));
		await submit();
		const [create] = commands.filter(command => command.type === "worktree_create");
		expect(create).toMatchObject({ type: "worktree_create", name: "Login" });
		expect(create).not.toHaveProperty("branchPrefix");
	});
});
