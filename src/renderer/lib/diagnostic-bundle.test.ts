/**
 * "Save diagnostic bundle" from the renderer: what it asks main for (the tab, its title, the variant), the one
 * toast each outcome gets, one save at a time, and Settings' button taking the focused tab.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticBundleRequest, DiagnosticBundleResult } from "../../shared/diagnostic-bundle";
import { useTabsStore } from "../stores/tabs";
import { useToastStore } from "../stores/toast";
import { saveDiagnosticBundle, saveFocusedDiagnosticBundle } from "./diagnostic-bundle";
import { translate } from "./i18n";

const SAVED: DiagnosticBundleResult = {
	ok: true,
	path: "/Users/me/omp-dump.zip",
	files: ["session.md", "ompdesk-diagnostics.txt"],
	subagentCount: 0,
	anonymized: false,
};

function install(answer: (request: DiagnosticBundleRequest) => Promise<DiagnosticBundleResult>) {
	const save = vi.fn(answer);
	Object.assign(globalThis, { window: { omp: { sessions: { saveDiagnosticBundle: save } } } });
	return save;
}

const toasts = () => useToastStore.getState().toasts;

afterEach(() => {
	useToastStore.setState({ toasts: [] });
	useTabsStore.setState({ tabs: [], activeTabId: null });
});

describe("saveDiagnosticBundle", () => {
	it("asks main for the tab with the variant chosen, then says where the file went", async () => {
		const save = install(async () => SAVED);

		await saveDiagnosticBundle({ tabId: "t1", title: "Fix login" }, true);

		expect(save).toHaveBeenCalledExactlyOnceWith({ tabId: "t1", title: "Fix login", anonymized: true });
		expect(toasts().map(toast => [toast.variant, toast.title, toast.message])).toEqual([
			["success", translate("diagnosticBundle.saved"), SAVED.ok ? SAVED.path : ""],
		]);
	});

	it("says nothing when the person cancels the dialog", async () => {
		install(async () => ({ ok: false, cancelled: true }));
		await saveDiagnosticBundle({ tabId: "t1" }, false);
		expect(toasts()).toEqual([]);
	});

	it("warns, in words, when there is nothing to save yet instead of reporting a failure", async () => {
		install(async () => ({ ok: false, error: "No messages to dump yet.", code: "no_messages" }));
		await saveDiagnosticBundle({ tabId: "t1" }, false);
		expect(toasts().map(toast => [toast.variant, toast.message])).toEqual([
			["warning", translate("ipcError.no_messages")],
		]);
	});

	it("reports any other failure as an error with the raw cause under it", async () => {
		install(async () => ({ ok: false, error: "EACCES: permission denied", code: "file_too_large" }));
		await saveDiagnosticBundle({ tabId: "t1" }, false);
		expect(toasts().map(toast => [toast.variant, toast.title, toast.detail])).toEqual([
			["error", translate("diagnosticBundle.failed"), "EACCES: permission denied"],
		]);
	});

	it("reports a call that threw (the link dropped) as an error", async () => {
		install(async () => {
			throw new Error("remote_offline");
		});
		await saveDiagnosticBundle({ tabId: "t1" }, false);
		expect(toasts().map(toast => toast.variant)).toEqual(["error"]);
	});

	it("runs one save at a time: a second press while the dialog is open does nothing", async () => {
		const first = Promise.withResolvers<DiagnosticBundleResult>();
		const save = install(() => first.promise);

		const pending = saveDiagnosticBundle({ tabId: "t1" }, false);
		await saveDiagnosticBundle({ tabId: "t1" }, true);
		expect(save).toHaveBeenCalledTimes(1);

		first.resolve({ ok: false, cancelled: true });
		await pending;
		install(async () => SAVED);
		await saveDiagnosticBundle({ tabId: "t1" }, false);
		expect(toasts()).toHaveLength(1);
	});
});

describe("saveFocusedDiagnosticBundle", () => {
	const tab = { cwd: "/p", status: "ready" as const, kind: "agent" as const, unreadDone: false };

	it("saves the focused tab under its title, a paired host's tab included", async () => {
		const save = install(async () => SAVED);
		useTabsStore.setState({
			tabs: [
				{ ...tab, id: "t1", title: "Other" },
				{ ...tab, id: "t2", title: "Host work", device: "host-1" },
			],
			activeTabId: "t2",
		});

		await saveFocusedDiagnosticBundle(false);

		expect(save).toHaveBeenCalledExactlyOnceWith({ tabId: "t2", title: "Host work", anonymized: false });
	});

	it("asks for a session first when no tab is open", async () => {
		const save = install(async () => SAVED);
		useTabsStore.setState({ tabs: [], activeTabId: null });

		await saveFocusedDiagnosticBundle(false);

		expect(save).not.toHaveBeenCalled();
		expect(toasts().map(toast => [toast.variant, toast.message])).toEqual([
			["warning", translate("diagnosticBundle.noSession")],
		]);
	});

	it("passes over a ghost tab, which nothing runs behind", async () => {
		const save = install(async () => SAVED);
		useTabsStore.setState({ tabs: [{ ...tab, id: "old", ghost: true }], activeTabId: "old" });

		await saveFocusedDiagnosticBundle(true);

		expect(save).not.toHaveBeenCalled();
	});
});
