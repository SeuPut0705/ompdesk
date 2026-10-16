/**
 * Once per launch, when the sidecar first reports ready: with no provider
 * that can serve, start the inline first-run setup (the empty main area
 * renders it); a setup left at a later step (model, GitHub) before a relaunch
 * resumes there; otherwise make sure new sessions start on a model that can
 * serve (`ensureServingDefault`). Renders nothing.
 */

import { useEffect, useRef } from "react";
import type { ProviderInfo } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { FIRST_RUN_STEP_PREF, isResumableFirstRunStep, useFirstRunStore } from "../../stores/first-run";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { useModelStore } from "../../stores/model";
import { focusedTabDevice } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { hasUsableModelProvider, modelDisplayName, toProviderInfo } from "../settings/providers/provider-catalog";
import { ensureServingDefault } from "./default-model";

export function FirstRunGate() {
	const tabRpc = useTabRpc();
	const t = useT();
	const status = useSessionStore(state => state.status);
	const refreshProviders = useModelStore(state => state.refreshProviders);
	const checkedThisLaunch = useRef(false);
	const ompInstalled = useMachineSetupStore(state => state.ompInstalled);
	const takeover = useMachineSetupStore(state => state.takeover);

	// The first window's React tree is up (this gate mounts with App): a launch timing mark.
	useEffect(() => window.omp.runtime.startupMark("renderer-mounted"), []);

	// Machine setup just installed omp, so it never ran and holds no provider: the provider step shows the
	// moment the setup screen leaves, while omp's first boot runs (seconds on Windows, where cmd.exe, a cold
	// disk and the virus scan of a fresh install all sit in it); its providers fill in once the session is
	// ready. The check below settles it: no serving provider keeps it, one that serves after all (an omp
	// reinstalled over an agent dir with credentials) closes it again.
	useEffect(() => {
		if (!ompInstalled || takeover || checkedThisLaunch.current) return;
		useFirstRunStore.getState().openProvisional();
	}, [ompInstalled, takeover]);

	useEffect(() => {
		if (status !== "ready" || checkedThisLaunch.current) return;
		let cancelled = false;
		window.omp.runtime.startupMark("first-run-check");
		void (async () => {
			const [catalogResult, configResult, savedStep] = await Promise.allSettled([
				refreshProviders(false),
				window.omp.models.listProviders(focusedTabDevice()),
				window.omp.prefs.get(FIRST_RUN_STEP_PREF),
			]);
			// A failed catalog read is transient (sidecar/transport): stay
			// unlatched so the next ready transition checks again.
			if (cancelled || catalogResult.status === "rejected") return;
			checkedThisLaunch.current = true;
			const providers = catalogResult.value.providers
				.map(toProviderInfo)
				.filter((row): row is ProviderInfo => row !== null);
			const configs = configResult.status === "fulfilled" ? configResult.value.providers : [];
			if (!hasUsableModelProvider(providers, configs)) {
				useFirstRunStore.getState().setPhase("connect", null);
				return;
			}
			if (useFirstRunStore.getState().provisional) useFirstRunStore.getState().setPhase("idle", null);
			const resume = savedStep.status === "fulfilled" ? savedStep.value : undefined;
			if (isResumableFirstRunStep(resume)) {
				useFirstRunStore.getState().setPhase(resume, null);
				return;
			}
			try {
				const outcome = await ensureServingDefault(tabRpc, useTabsStore.getState().activeTabId, {
					providers,
					configs,
					models: catalogResult.value.models,
					current: useModelStore.getState().model,
				});
				if (outcome.kind === "switched" && outcome.from) {
					toast({
						variant: "info",
						title: t("setup.defaultSwitched.title"),
						message: t("setup.defaultSwitched.message", {
							model: modelDisplayName(outcome.model),
							from: modelDisplayName(outcome.from),
						}),
					});
				}
			} catch {
				// Best effort: the session still runs on whatever omp picked, and the
				// composer's model chip and error recovery stay available.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [refreshProviders, status, t, tabRpc]);

	return null;
}
