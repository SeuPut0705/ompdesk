/**
 * WorkspaceDialog's "Add workspace": a local tab uses main's native picker
 * (`sidecar.selectProject`); a remote tab closes the dialog, browses its host
 * with the remote folder picker, then re-roots there (`sidecar.setProject`)
 * or opens the new session on that host.
 */

import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteDirListing, SessionInfo } from "../../../shared/ipc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useRemotePickerStore, useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { setFocusedSessionRuntime } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { RemoteFolderPickerHost } from "../remote/RemoteFolderPicker";
import { WorkspaceDialog } from "./WorkspaceDialog";

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
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const HOME: RemoteDirListing = {
	path: "/Users/kim",
	parent: "/Users",
	entries: [{ name: "code", path: "/Users/kim/code" }],
};

const omp = {
	sessions: { list: vi.fn(async (_scope: string, _device?: string): Promise<SessionInfo[]> => []) },
	events: { onSessionsChanged: vi.fn(() => () => {}) },
	sidecar: {
		selectProject: vi.fn(async (): Promise<string | null> => "/work/local"),
		setProject: vi.fn(async (_cwd: string) => true),
	},
	remote: {
		listDirs: vi.fn(
			async (_deviceId: string, path?: string): Promise<RemoteDirListing> =>
				path === undefined ? HOME : { path, parent: "/Users/kim", entries: [] },
		),
	},
	tabs: {
		spawn: vi.fn(async (_payload: unknown) => ({ tabId: "t-new", cwd: "/Users/kim" })),
		setView: vi.fn(async () => true),
		setActive: vi.fn(async () => true),
	},
	rpc: { liveStop: vi.fn() },
};
Object.assign(window as unknown as Record<string, unknown>, { omp });

let root: Root | null = null;
let closed = 0;

function Harness({ intent }: { intent: "switch" | "new-session" }) {
	const [open, setOpen] = useState(true);
	return (
		<>
			<WorkspaceDialog
				intent={intent}
				onClose={() => {
					closed++;
					setOpen(false);
				}}
				open={open}
			/>
			<RemoteFolderPickerHost />
		</>
	);
}

function seedTab(device?: string): void {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/Users/kim/code", status: "ready", kind: "agent", unreadDone: false, device }],
		activeTabId: "t1",
	});
	setFocusedSessionRuntime("t1");
}

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
}

async function mount(intent: "switch" | "new-session"): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<Harness intent={intent} />
			</I18nProvider>,
		);
	});
	await settle();
}

async function clickAdd(): Promise<void> {
	const add = Array.from(document.body.querySelectorAll("button")).find(
		button => (button.textContent ?? "").trim() === translate("workspaces.add"),
	) as unknown as HTMLButtonElement;
	await act(async () => add.click());
	await settle();
}

async function chooseRemoteFolder(): Promise<void> {
	await act(async () =>
		(document.body.querySelector('[data-remote-dir="/Users/kim/code"]') as HTMLButtonElement).click(),
	);
	await settle();
	await act(async () => (document.body.querySelector("[data-remote-picker-open]") as HTMLButtonElement).click());
	await settle();
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useRemotePickerStore.setState({ request: null });
	useRemoteStore.getState().reset();
	useTabsStore.getState().reset();
	useSessionStore.getState().reset();
	closed = 0;
	vi.clearAllMocks();
});

describe("WorkspaceDialog folder picker", () => {
	it("uses the native picker on a local tab", async () => {
		seedTab();
		await mount("switch");
		await clickAdd();

		expect(omp.sidecar.selectProject).toHaveBeenCalledTimes(1);
		expect(omp.remote.listDirs).not.toHaveBeenCalled();
		expect(closed).toBe(1);
	});

	it("browses the host on a remote tab, then re-roots the tab there", async () => {
		seedTab("dev-studio");
		useRemoteStore.getState().apply({
			tailnet: "ready",
			host: {
				enabled: false,
				name: "laptop",
				port: null,
				addresses: [],
				listenError: null,
				peers: [],
				keepAwake: true,
				keepingAwake: false,
				usedBy: [],
			},
			hosts: [{ deviceId: "dev-studio", name: "studio", state: "online" }],
			forgotten: [],
		});
		await mount("switch");
		expect(omp.sessions.list).toHaveBeenCalledWith("global", "dev-studio");

		await clickAdd();
		// The workspace dialog steps aside for the picker.
		expect(closed).toBe(1);
		expect(omp.sidecar.selectProject).not.toHaveBeenCalled();
		expect(omp.remote.listDirs).toHaveBeenCalledWith("dev-studio");
		expect(document.body.textContent).toContain(translate("remote.picker.title", { name: "studio" }));

		await chooseRemoteFolder();
		expect(omp.sidecar.setProject).toHaveBeenCalledWith("/Users/kim/code");
	});

	it("opens a new session on the host from a remote tab", async () => {
		seedTab("dev-studio");
		await mount("new-session");
		await clickAdd();
		await chooseRemoteFolder();

		expect(omp.tabs.spawn).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/Users/kim/code", kind: "agent", device: "dev-studio" }),
		);
		expect(omp.sidecar.setProject).not.toHaveBeenCalled();
	});
});

describe("WorkspaceDialog rows", () => {
	it("keeps the tail of a long project path, where sibling projects differ", async () => {
		seedTab();
		const parent = "/private/var/folders/0m/4j2lsbfs0xg1gnc95z_6g_sc0000gn/T/omp-gui-shell-audit-goZQw";
		const session = (cwd: string): SessionInfo => ({
			path: `${cwd}/s.jsonl`,
			id: cwd,
			title: null,
			cwd,
			created: "2026-10-13T00:00:00Z",
			modified: "2026-10-13T00:00:00Z",
			messageCount: 1,
			size: 1,
			status: "complete",
			firstMessage: "",
		});
		omp.sessions.list.mockResolvedValue([session(`${parent}/project`), session(`${parent}/website`)]);
		await mount("switch");
		const text = document.body.textContent ?? "";
		expect(text).toContain("…");
		expect(text).toContain("goZQw/project");
		expect(text).toContain("goZQw/website");
		expect(document.body.querySelector(`[title="${parent}/website"]`)).not.toBeNull();
		omp.sessions.list.mockImplementation(async () => []);
	});

	it("marks the current project's row for screen readers and names each row by its project alone", async () => {
		seedTab();
		useSessionStore.setState({ cwd: "/Users/kim/code/app" });
		const session = (cwd: string): SessionInfo => ({
			path: `${cwd}/s.jsonl`,
			id: cwd,
			title: null,
			cwd,
			created: "2026-10-13T00:00:00Z",
			modified: "2026-10-13T00:00:00Z",
			messageCount: 1,
			size: 1,
			status: "complete",
			firstMessage: "",
		});
		omp.sessions.list.mockResolvedValue([session("/Users/kim/code/app"), session("/Users/kim/code/site")]);
		await mount("switch");
		const rows = Array.from(document.body.querySelectorAll("button")).filter(button =>
			["app", "site"].includes((button.textContent ?? "").trim()),
		);
		expect(rows.map(row => [row.textContent?.trim(), row.getAttribute("aria-current")])).toEqual([
			["app", "true"],
			["site", null],
		]);
		omp.sessions.list.mockImplementation(async () => []);
	});
});
