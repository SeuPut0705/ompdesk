/**
 * The Autopilot timeline's sha link: `changesFocusCommit` makes the commits view open that commit (a short sha is
 * resolved against the log) and is cleared once taken.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand, RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { useUiStore } from "../../../stores/ui";
import { CommitHistory } from "./CommitHistory";

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

const FULL = "9f3c0e1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const commit = (sha: string, subject: string) => ({
	sha,
	shortSha: sha.slice(0, 7),
	subject,
	author: "a",
	date: 1_760_000_000,
	parents: [],
	refs: [],
	tags: [],
});
const ok = (command: string, data: unknown): RpcResponse => ({ type: "response", command, success: true, data });

const sent: RpcCommand[] = [];
const command = vi.fn(async (cmd: RpcCommand): Promise<RpcResponse> => {
	sent.push(cmd);
	if (cmd.type === "git_log")
		return ok("git_log", { commits: [commit(FULL, "Add resume e2e")], more: false, commitUrl: null });
	if (cmd.type === "git_commit_detail")
		return ok("git_commit_detail", { ...commit(FULL, "Add resume e2e"), body: "", files: [] });
	return ok(cmd.type, {});
});
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { rpc: { command }, prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) } },
});

let root: Root | undefined;

async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<CommitHistory />
			</I18nProvider>,
		);
	});
	await act(async () => {});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	sent.length = 0;
	useUiStore.setState({ changesFocusCommit: null });
});

describe("CommitHistory focus from the Autopilot timeline", () => {
	it("opens the focused commit by its short sha once the log is here, and clears the request", async () => {
		useUiStore.setState({ changesFocusCommit: "9f3c0e1" });
		await mount();
		await act(async () => {});
		expect(sent.find(item => item.type === "git_commit_detail")).toMatchObject({ sha: FULL });
		expect(useUiStore.getState().changesFocusCommit).toBeNull();
	});

	it("opens nothing by itself without a request", async () => {
		await mount();
		expect(sent.some(item => item.type === "git_commit_detail")).toBe(false);
	});
});
