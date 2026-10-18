/**
 * useGithubLoad paints the last answer of its request at the first frame (lib/last-read.ts) and reads again in
 * place: a list opened before is never a spinner, another folder's or another request's answer is never shown.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubRequest } from "../../shared/github";
import { useTabsStore } from "../stores/tabs";
import { type GithubLoad, useGithubLoad } from "./github";
import { rememberRead, resetLastReadForTest } from "./last-read";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");

const REQUEST: GithubRequest = { op: "issue_list", host: "github.com", repo: "acme/widgets" } as GithubRequest;
let seen: GithubLoad<unknown> | null = null;

function Probe({ request, id }: { request: GithubRequest; id: string }) {
	seen = useGithubLoad(request, id);
	return null;
}

let root: ReturnType<typeof createRoot> | null = null;

async function mount(id: string): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(<Probe id={id} request={REQUEST} />);
	});
}

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	seen = null;
	resetLastReadForTest();
	useTabsStore.setState({ tabs: [], activeTabId: null });
	vi.restoreAllMocks();
});

describe("useGithubLoad snapshots", () => {
	it("returns the last answer of this request on the first render, while the read is still pending", async () => {
		const command = vi.fn(() => new Promise(() => {}));
		Object.assign(window, { omp: { rpc: { command } } });
		rememberRead(undefined, `github:${""}:issue_list:key-1`, [{ number: 1 }], false);
		await mount("key-1");
		expect(seen?.data).toEqual([{ number: 1 }]);
		expect(seen?.loading).toBe(true);
	});

	it("never shows another request's answer", async () => {
		Object.assign(window, { omp: { rpc: { command: vi.fn(() => new Promise(() => {})) } } });
		rememberRead(undefined, `github:${""}:issue_list:key-1`, [{ number: 1 }], false);
		await mount("key-2");
		expect(seen?.data).toBeNull();
	});

	it("replaces the snapshot with the live answer and remembers it", async () => {
		const live = [{ number: 2 }];
		Object.assign(window, {
			omp: {
				rpc: { command: vi.fn(async () => ({ type: "response", command: "github", success: true, data: live })) },
			},
		});
		rememberRead(undefined, `github:${""}:issue_list:key-1`, [{ number: 1 }], false);
		await mount("key-1");
		await act(async () => {
			await Promise.resolve();
		});
		expect(seen?.data).toEqual(live);
		expect(seen?.loading).toBe(false);
	});
});
