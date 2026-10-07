/**
 * Agent settings data for the Settings page: the schema, current values,
 * and provenance from the gui-bridge (get_settings_schema / get_settings),
 * loaded once per page visit and on sidecar reconnect, refreshed on
 * config_update. Sections read it through `useSettingsData()`; schema rows
 * write through set_setting themselves and report back via `onCommitted`.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { SettingProvenance, SettingsSchemaResult } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";
import { focusedSessionRuntime } from "../../stores/session-runtime-context";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";

export type LoadState = "loading" | "error" | "ready";

interface SettingsResponseData {
	values?: Record<string, unknown>;
	provenance?: Record<string, SettingProvenance>;
	advisorEnabled?: boolean;
	advisorActive?: boolean;
}

export interface SettingsData {
	schema: SettingsSchemaResult | null;
	values: Record<string, unknown>;
	loadState: LoadState;
	loadError: string | null;
	sidecarReady: boolean;
	/** A turn, compaction, or foreground execution is running: never restart under it. */
	sidecarBusy: boolean;
	advisorActive: boolean | undefined;
	onCommitted: (path: string, value: unknown) => void;
	/** Re-read schema and values (and restart a dead sidecar). */
	retry: () => void;
}

const SettingsDataContext = createContext<SettingsData | null>(null);
export const SettingsDataProvider = SettingsDataContext.Provider;

export function useSettingsData(): SettingsData {
	const data = useContext(SettingsDataContext);
	if (!data) throw new Error("useSettingsData() outside SettingsPage");
	return data;
}

/** Bash/eval bubbles are the live execution signal and vanish only after their RPC settles. */
export function useSidecarBusy(): boolean {
	const sessionBusy = useSessionStore(state => state.isStreaming || state.isCompacting);
	const executionBusy = useMessagesStore(state =>
		state.messages.some(
			message =>
				(message.role === "bashExecution" || message.role === "pythonExecution") && message.running === true,
		),
	);
	return sessionBusy || executionBusy;
}

/** Owns the agent-settings state for one mounted Settings page. */
export function useSettingsDataLoader(): SettingsData {
	const tabRpc = useTabRpc();
	const t = useT();
	const sidecarStatus = useSessionStore(state => state.status);
	const sidecarReady = sidecarStatus === "ready";
	const sidecarBusy = useSidecarBusy();
	const [loadState, setLoadState] = useState<LoadState>("loading");
	const [loadError, setLoadError] = useState<string | null>(null);
	const [schema, setSchema] = useState<SettingsSchemaResult | null>(null);
	const [values, setValues] = useState<Record<string, unknown>>({});
	const [advisorActive, setAdvisorActive] = useState<boolean>();
	const [reloadToken, setReloadToken] = useState(0);
	const settingsVersion = useRef(0);

	const retry = useCallback(() => {
		useUiStore.getState().clearSidecarError();
		setReloadToken(token => token + 1);
		if (sidecarBusy || sidecarStatus === "ready" || sidecarStatus === "starting" || sidecarStatus === "restarting")
			return;
		const runtime = focusedSessionRuntime();
		const sessionFile = useSessionStore.getState().sessionFile;
		void window.omp.sidecar
			.restart({ tabId: runtime?.tabId, sessionPath: sessionFile ?? undefined })
			.catch(error => toastError({ title: t("settings.connection.restartFailed"), error }));
	}, [sidecarBusy, sidecarStatus, t]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is the explicit retry trigger.
	useEffect(() => {
		if (!sidecarReady) {
			// Keep cached schema data for navigation, but never look editable while the RPC owner is down.
			setLoadState("loading");
			setLoadError(null);
			return;
		}
		let cancelled = false;
		const version = ++settingsVersion.current;
		setLoadState("loading");
		setLoadError(null);
		void (async () => {
			try {
				const [schemaRes, settingsRes] = await Promise.all([tabRpc.getSettingsSchema(), tabRpc.getSettings()]);
				if (cancelled) return;
				if (!schemaRes.success) {
					setSchema(null);
					setLoadError(schemaRes.error);
					setLoadState("error");
					return;
				}
				const result = schemaRes.data as SettingsSchemaResult | undefined;
				if (!result || !Array.isArray(result.entries) || !Array.isArray(result.tabs)) {
					setSchema(null);
					setLoadError(t("settings.schemaMalformed"));
					setLoadState("error");
					return;
				}
				const nextValues: Record<string, unknown> = {};
				for (const entry of result.entries) nextValues[entry.path] = entry.value;
				if (settingsRes.success) {
					const data = settingsRes.data as SettingsResponseData | undefined;
					if (data?.values) Object.assign(nextValues, data.values);
					if (typeof data?.advisorEnabled === "boolean") nextValues["advisor.enabled"] = data.advisorEnabled;
					setAdvisorActive(data?.advisorActive);
				}
				setSchema(result);
				setValues(previous => (version === settingsVersion.current ? nextValues : { ...nextValues, ...previous }));
				setLoadState("ready");
			} catch (err) {
				if (!cancelled) {
					setSchema(null);
					setLoadError(String(err));
					setLoadState("error");
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [reloadToken, sidecarReady, t, tabRpc]);

	// External edits (composer controls, TUI, another window) push config_update:
	// refetch values only; per-row drafts win over `values`, so in-progress edits survive.
	useEffect(() => {
		let cancelled = false;
		const unsubscribe = window.omp.events.onConfigUpdate(() => {
			const version = ++settingsVersion.current;
			void tabRpc
				.getSettings()
				.then(res => {
					if (cancelled || version !== settingsVersion.current || !res.success) return;
					const data = res.data as SettingsResponseData | undefined;
					if (!data?.values) return;
					const nextValues = { ...data.values };
					if (typeof data.advisorEnabled === "boolean") nextValues["advisor.enabled"] = data.advisorEnabled;
					setValues(prev => ({ ...prev, ...nextValues }));
					const provenance = data.provenance;
					if (provenance)
						setSchema(previous =>
							previous
								? {
										...previous,
										entries: previous.entries.map(entry => ({
											...entry,
											provenance: provenance[entry.path] ?? entry.provenance,
										})),
									}
								: previous,
						);
					setAdvisorActive(data.advisorActive);
				})
				.catch(() => {});
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [tabRpc.getSettings]);

	const onCommitted = useCallback((path: string, value: unknown) => {
		settingsVersion.current++;
		setValues(prev => ({ ...prev, [path]: value }));
	}, []);

	return { schema, values, loadState, loadError, sidecarReady, sidecarBusy, advisorActive, onCommitted, retry };
}
