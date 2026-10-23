/**
 * The Changes panel's branch picker from the keyboard: a filter that matches a branch never makes a new one on Enter
 * (it goes to the branch, whose own Enter switches), ↑/↓ walk the branches, and Enter creates only when nothing the
 * filter matches can be switched to.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand, RpcGitBranch, RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import type { TabRpc } from "../../../lib/tab-rpc";
import { BranchPicker } from "./BranchPicker";
import type { ScmRunner } from "./use-scm-action";

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
// linkedom has no focus model: record what `focus()` reached so the keyboard route can be asserted.
let focused: unknown = null;
Object.defineProperty(HTMLElement.prototype, "focus", {
	configurable: true,
	value(this: unknown) {
		focused = this;
	},
});
Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused });

const branch = (name: string, extra: Partial<RpcGitBranch> = {}): RpcGitBranch => ({
	name,
	remote: false,
	current: false,
	upstream: null,
	worktree: null,
	sha: "0".repeat(40),
	date: 1_760_000_000,
	...extra,
});
const BRANCHES = [branch("main", { current: true }), branch("feature/login"), branch("feature/logout")];

const run = vi.fn(async () => undefined);
const runner = { busy: null, run } as unknown as ScmRunner;
const rpc = {
	command: async (command: RpcCommand): Promise<RpcResponse> => ({
		type: "response",
		command: command.type,
		success: true,
		data: command.type === "git_branches" ? BRANCHES : {},
	}),
} as unknown as TabRpc;

let root: Root | undefined;

async function openPicker(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<BranchPicker branch="main" requestName={() => {}} rpc={rpc} runner={runner} />
			</I18nProvider>,
		);
	});
	const chip = document.querySelector("button[aria-haspopup]") as unknown as globalThis.HTMLButtonElement;
	await act(async () => chip.click());
	await act(async () => {});
}

function field(): globalThis.HTMLInputElement {
	return document.querySelector('input[type="search"], input') as unknown as globalThis.HTMLInputElement;
}

/** React reads its own handlers; linkedom's dispatched keydown trips React's input polyfill. */
function reactProps(node: unknown): Record<string, (event: unknown) => void> {
	const key = Object.keys(node as object).find(name => name.startsWith("__reactProps$"));
	return (node as Record<string, Record<string, (event: unknown) => void>>)[key ?? ""];
}

async function type(value: string): Promise<void> {
	await act(async () => reactProps(field()).onChange({ target: { value }, currentTarget: { value } }));
}

async function key(target: unknown, name: string): Promise<{ prevented: boolean }> {
	const state = { prevented: false };
	await act(async () =>
		reactProps(target).onKeyDown({
			key: name,
			currentTarget: target,
			target,
			nativeEvent: { isComposing: false },
			preventDefault: () => {
				state.prevented = true;
			},
		}),
	);
	return state;
}

function rows(): globalThis.HTMLButtonElement[] {
	return [...document.querySelectorAll("button[data-branch-row]")] as unknown as globalThis.HTMLButtonElement[];
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	focused = null;
	run.mockClear();
});

describe("BranchPicker from the keyboard", () => {
	it("goes to the matching branch on Enter instead of creating a branch named after the filter", async () => {
		await openPicker();
		await type("feat");
		await key(field(), "Enter");
		expect(run).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(rows().find(row => row.textContent?.includes("feature/login")));
	});

	it("walks the branches with the arrows, past the current one, and back to the filter", async () => {
		await openPicker();
		await key(field(), "ArrowDown");
		const [login, logout] = rows().filter(row => !row.disabled);
		expect(document.activeElement).toBe(login);
		await key(login, "ArrowDown");
		expect(document.activeElement).toBe(logout);
		await key(logout, "ArrowUp");
		await key(login, "ArrowUp");
		expect(document.activeElement).toBe(field());
	});

	it("creates a branch on Enter when the filter matches none", async () => {
		await openPicker();
		await type("hotfix");
		await key(field(), "Enter");
		expect(run).toHaveBeenCalledWith(
			"create",
			{ type: "git_branch", action: "create", name: "hotfix" },
			expect.anything(),
		);
	});
});
