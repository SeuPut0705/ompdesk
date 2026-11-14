import type { AgentControlViewEvent } from "../../shared/agent-control";
import { forgetSplitTab, splitTabIds } from "../../shared/split-layout";
import { autoCloseHeld } from "../lib/agent-auto-close";
import { translate } from "../lib/i18n";
import { deleteSessionRuntime } from "./session-runtime-context";
import { isTabClosed, useTabsStore, visibleTabIds } from "./tabs";
import { toastError } from "./toast";
import { useUiStore } from "./ui";

const CLOSED_TAB_LIMIT = 20;

async function prepareLastTabClose(id: string, closedTabIds: Set<string>): Promise<boolean> {
	closedTabIds.add(id);
	const get = useTabsStore.getState;
	if (get().tabs.length === 1 && (await get().openTab({ work: true, placeholder: true })) === null) {
		closedTabIds.delete(id);
		return false;
	}
	return true;
}

export async function closeTab(id: string, closeRequest: string | undefined, closedTabIds: Set<string>): Promise<void> {
	const get = useTabsStore.getState;
	const set = useTabsStore.setState;
	let state = get();
	let index = state.tabs.findIndex(tab => tab.id === id);
	if ((!closeRequest && state.tabs.length <= 1) || index === -1 || state.tabs[index]?.ghost) {
		if (closeRequest) await window.omp.tabs.close(id, closeRequest, true).catch(() => false);
		return;
	}
	const ui = useUiStore.getState();
	if (ui.fileEditDirty && ui.fileEditTabId === id) {
		if (closeRequest) {
			await window.omp.tabs.close(id, closeRequest, true).catch(() => false);
			return;
		}
		ui.holdTabClose(id);
		return;
	}
	if (closeRequest && state.tabs.length === 1) {
		if (!(await prepareLastTabClose(id, closedTabIds))) {
			await window.omp.tabs.close(id, closeRequest, true).catch(() => false);
			return;
		}
		state = get();
		index = state.tabs.findIndex(tab => tab.id === id);
		if (index < 0) {
			await window.omp.tabs.close(id, closeRequest, true).catch(() => false);
			return;
		}
	}
	if (state.split && splitTabIds(state.split).includes(id)) {
		await get().removePane(id);
	} else if (id === state.activeTabId) {
		const neighbor = state.tabs[index + 1] ?? state.tabs[index - 1];
		if (neighbor) await get().switchTab(neighbor.id);
	}
	if (closeRequest) {
		const latest = useUiStore.getState();
		if (latest.fileEditDirty && (latest.fileEditTabId === id || latest.fileEditTabId === null)) {
			closedTabIds.delete(id);
			await window.omp.tabs.close(id, closeRequest, true).catch(() => false);
			return;
		}
	}
	const closed = state.tabs[index];
	set(current => {
		const closedTabs = closed?.sessionPath
			? [
					...current.closedTabs.filter(entry => entry.sessionPath !== closed.sessionPath),
					{
						sessionPath: closed.sessionPath,
						cwd: closed.cwd,
						kind: closed.kind,
						...(closed.device === undefined ? {} : { device: closed.device }),
						...(closed.title ? { title: closed.title } : {}),
					},
				].slice(-CLOSED_TAB_LIMIT)
			: current.closedTabs;
		return {
			tabs: current.tabs.filter(tab => tab.id !== id),
			rememberedSplits: forgetSplitTab(current.rememberedSplits, id),
			closedTabs,
		};
	});
	closedTabIds.add(id);
	let failure: unknown = null;
	try {
		const released = await (closeRequest ? window.omp.tabs.close(id, closeRequest) : window.omp.tabs.close(id));
		if (!released) failure = new Error(`Tab ${id} was not released`);
	} catch (error) {
		failure = error;
	}
	if (failure !== null) {
		closedTabIds.delete(id);
		const listed = await get().reconcileTabs();
		if (listed && !get().tabs.some(tab => tab.id === id)) {
			closedTabIds.add(id);
			deleteSessionRuntime(id);
			return;
		}
		if (closed?.sessionPath)
			set(current => ({
				closedTabs: current.closedTabs.filter(entry => entry.sessionPath !== closed.sessionPath),
			}));
		toastError({ title: translate("tabs.closeFailed"), error: failure });
		return;
	}
	deleteSessionRuntime(id);
	const { split } = get();
	if (split && splitTabIds(split).includes(id)) await get().reconcileTabs();
}

export async function closeDeletedSession(
	sessionPath: string,
	tabId: string | undefined,
	closedTabIds: Set<string>,
): Promise<boolean> {
	const get = useTabsStore.getState;
	const tab = tabId ? get().tabs.find(entry => entry.id === tabId) : undefined;
	if (tab) {
		if (!(await prepareLastTabClose(tab.id, closedTabIds))) return false;
		await closeTab(tab.id, undefined, closedTabIds);
		if (get().tabs.some(entry => entry.id === tab.id)) {
			closedTabIds.delete(tab.id);
			return false;
		}
	}
	useTabsStore.setState(current => ({
		closedTabs: current.closedTabs.filter(entry => entry.sessionPath !== sessionPath),
	}));
	return true;
}

export async function applyAgentView(event: AgentControlViewEvent, closedTabIds: Set<string>): Promise<void> {
	const { tabId, how, auto, closeRequest } = event;
	const get = useTabsStore.getState;
	if (!get().tabs.some(tab => tab.id === tabId)) await get().reconcileTabs();
	const known = get().tabs.some(tab => tab.id === tabId);
	if (!known || isTabClosed(tabId)) {
		if (how === "close" && closeRequest) await window.omp.tabs.close(tabId, closeRequest, true).catch(() => false);
		return;
	}
	if (how === "close") {
		if (auto && autoCloseHeld(tabId, visibleTabIds(get()))) return;
		await closeTab(tabId, closeRequest, closedTabIds);
		return;
	}
	useUiStore.getState().closeDestination();
	if (how === "focus" || visibleTabIds(get()).includes(tabId)) {
		await get().switchTab(tabId);
		return;
	}
	await get().splitTab(tabId, how === "split-right" ? "right" : "bottom");
}
