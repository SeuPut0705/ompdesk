/**
 * Settings › Updates on a paired host's tab: the host's omp is updated by that host's own OmpUpdater
 * (`hostOmpUpdate.now`), and its state — checking, updating, a failure — follows the host's pushes like
 * the computer's own row, instead of a bare `omp update` run through the tab's RPC.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcHostOmpUpdate, RemoteState } from "../../../shared/ipc-types";
import type { OmpUpdateState } from "../../../shared/omp-update";
import type { RpcOmpUpdateResult } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useRemoteStore } from "../../stores/remote";
import { useToastStore } from "../../stores/toast";
import { HostOmpUpdateRow } from "./UpdatesSection";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

const CORE: RpcOmpUpdateResult = {
	currentVersion: "18.8.7",
	latestVersion: "18.9.0",
	updateAvailable: true,
	checkedAt: "2026-10-15T00:00:00.000Z",
	distribution: "system",
	installStrategy: "omp-update",
};

function hostState(patch: Partial<OmpUpdateState> = {}): OmpUpdateState {
	return {
		enabled: true,
		scheduled: true,
		phase: "idle",
		installed: "18.8.7",
		latest: "18.9.0",
		checkedAt: 1,
		updatedTo: null,
		failure: null,
		...patch,
	};
}

let current = hostState();
let listener: ((update: IpcHostOmpUpdate) => void) | null = null;
const hostOmpUpdate = {
	get: vi.fn(async (_device: string) => current),
	now: vi.fn(async (_device: string) => hostState({ phase: "checking" })),
	onState: vi.fn((callback: (update: IpcHostOmpUpdate) => void) => {
		listener = callback;
		return () => {
			listener = null;
		};
	}),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { hostOmpUpdate } });

let root: Root | null = null;
const onSettled = vi.fn();

async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<HostOmpUpdateRow
					checking={false}
					core={CORE}
					coreError={undefined}
					deviceId="dev-studio"
					onSettled={onSettled}
				/>
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
}

async function push(device: string, state: OmpUpdateState): Promise<void> {
	await act(async () => {
		listener?.({ device, state });
	});
}

function button(label: string): HTMLButtonElement | undefined {
	return (Array.from(document.body.querySelectorAll("button")) as HTMLButtonElement[]).find(
		candidate => (candidate.textContent ?? "").trim() === label,
	);
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useToastStore.setState({ toasts: [] });
	hostOmpUpdate.get.mockClear();
	hostOmpUpdate.now.mockClear();
	onSettled.mockClear();
	current = hostState();
});

describe("HostOmpUpdateRow", () => {
	it("starts the update on the host's own OmpUpdater and follows its pushed state to the end", async () => {
		await mount();
		expect(hostOmpUpdate.get).toHaveBeenCalledWith("dev-studio");

		await act(async () => {
			button(translate("updates.core.update"))?.click();
		});
		expect(hostOmpUpdate.now).toHaveBeenCalledWith("dev-studio");
		// Checking: the button is gone and a progress bar stands in for it.
		expect(button(translate("updates.core.update"))).toBeUndefined();
		expect(document.body.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe(
			translate("ompUpdate.status.checking"),
		);

		await push("dev-studio", hostState({ phase: "updating" }));
		expect(document.body.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe(
			translate("updates.core.updating"),
		);
		expect(onSettled).not.toHaveBeenCalled();

		// The host finished: the row re-reads `omp update --check` there and says what was installed.
		await push("dev-studio", hostState({ phase: "idle", installed: "18.9.0", updatedTo: "18.9.0" }));
		expect(onSettled).toHaveBeenCalledTimes(1);
		expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
			translate("updates.core.updated", { version: "18.9.0" }),
		);
	});

	it("shows why the host's update failed and does not toast a success", async () => {
		await mount();
		await push("dev-studio", hostState({ phase: "updating" }));
		await push("dev-studio", hostState({ failure: { reason: "install", detail: "bun install -g failed" } }));
		expect(onSettled).toHaveBeenCalledTimes(1);
		expect(document.body.textContent).toContain(translate("ompUpdate.failure.install", { latest: "18.9.0" }));
		expect(document.body.textContent).toContain("bun install -g failed");
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("picks up an update the host is already running, and ignores another device's pushes", async () => {
		current = hostState({ phase: "updating" });
		await mount();
		expect(button(translate("updates.core.update"))).toBeUndefined();
		expect(document.body.querySelector('[role="progressbar"]')).not.toBeNull();

		await push("someone-else", hostState());
		expect(document.body.querySelector('[role="progressbar"]')).not.toBeNull();
		expect(onSettled).not.toHaveBeenCalled();
	});

	it("toasts the reason when the host refuses to start", async () => {
		hostOmpUpdate.now.mockRejectedValueOnce(new Error("Error invoking remote method: [remote_offline] offline"));
		await mount();
		await act(async () => {
			button(translate("updates.core.update"))?.click();
		});
		await act(async () => {
			await Promise.resolve();
		});
		const toast = useToastStore.getState().toasts.at(-1);
		expect(toast?.title).toBe(translate("updates.core.updateFailed"));
		expect(JSON.stringify(toast)).toContain(translate("ipcError.remote_offline"));
	});

	it("says the omp it updates is the host's, by name, not this computer's", async () => {
		useRemoteStore.setState({
			state: { hosts: [{ deviceId: "dev-studio", name: "Studio", state: "online" }] } as unknown as RemoteState,
		});
		await mount();
		expect(document.body.textContent).toContain(translate("updates.core.hostDescription", { device: "Studio" }));
		expect(document.body.textContent).not.toContain(translate("updates.core.description"));
		useRemoteStore.getState().reset();
	});
});
