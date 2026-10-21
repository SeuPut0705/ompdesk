/**
 * What an agent's `ompdesk_app` call asks this window to show (`AGENT_CONTROL_APP`): a preference main already
 * wrote, applied to the live UI the way its Settings control applies it; a side panel; Settings opened; and the
 * quiet toast ("Agent changed: Theme → Nord") with one step back. Undo is the person's own click: it writes the
 * previous value through the same `prefs.set` / `set_setting` Settings uses.
 */
import { AGENT_VIEW_SHEETS, type AgentAppEvent, type AppUndo } from "../../shared/agent-control";
import { toast } from "../stores/toast";
import { migrateDefaultPanelTab, useUiStore } from "../stores/ui";
import { translate } from "./i18n";
import { applyThemeByName, isThemeSelection } from "./themes";

const UI_STATE_KEYS: Record<string, "boolean" | "number" | "string"> = {
	compactDensity: "boolean",
	colorBlindMode: "boolean",
	followAgentTheme: "boolean",
	notifications: "boolean",
	notificationSound: "boolean",
	linkPreview: "boolean",
	thinkingExpanded: "boolean",
	fontSize: "number",
	panelSide: "string",
	transcriptDetail: "string",
};

const DISPLAY_PREFIX = "displayPreferences.";

/** Apply a stored preference to the live window, as the Settings control that owns it does. */
export function applyAgentPref(key: string, value: unknown): void {
	if (key === "themeName") {
		if (isThemeSelection(value)) applyThemeByName(value);
		return;
	}
	if (key === "defaultPanelTab") {
		useUiStore.setState({ panelTab: migrateDefaultPanelTab(value) });
		return;
	}
	if (key.startsWith(DISPLAY_PREFIX)) {
		const field = key.slice(DISPLAY_PREFIX.length);
		useUiStore.setState(state => ({ displayPreferences: { ...state.displayPreferences, [field]: value } }));
		return;
	}
	const kind = UI_STATE_KEYS[key];
	if (kind && typeof value === kind) useUiStore.setState({ [key]: value });
}

async function undo(step: AppUndo): Promise<void> {
	if (step.kind === "pref") {
		await window.omp.prefs.set(step.key, step.value);
		applyAgentPref(step.key, step.value);
		return;
	}
	await window.omp.rpc.command({ type: "set_setting", path: step.path, value: step.value });
}

/** A view the agent named that opens as a sheet rather than in the side panel. */
function isViewSheet(tab: string): tab is (typeof AGENT_VIEW_SHEETS)[number] {
	return (AGENT_VIEW_SHEETS as readonly string[]).includes(tab);
}

export function applyAgentAppEvent(event: AgentAppEvent): void {
	switch (event.kind) {
		case "pref":
			applyAgentPref(event.key, event.value);
			return;
		case "panel":
			if (event.tab === null) useUiStore.setState({ panelVisible: false });
			else if (isViewSheet(event.tab)) useUiStore.getState().openViewSheet(event.tab);
			else useUiStore.getState().setPanelTab(event.tab);
			return;
		case "settings":
			useUiStore.getState().openSettings(event.sub ? `${event.section}:${event.sub}` : event.section);
			return;
		case "toast": {
			const step = event.undo;
			toast({
				variant: "info",
				message: event.message,
				...(step
					? {
							action: {
								label: translate("agentApp.undo"),
								run: () =>
									void undo(step).catch(() =>
										toast({ variant: "error", message: translate("settings.saveFailed") }),
									),
							},
						}
					: {}),
			});
			return;
		}
	}
}

/** Subscribe this window to the agent's app events; returns the unsubscribe. */
export function startAgentAppEvents(): () => void {
	const subscribe = window.omp.events.onAgentControlApp;
	return typeof subscribe === "function" ? subscribe.call(window.omp.events, applyAgentAppEvent) : () => undefined;
}
