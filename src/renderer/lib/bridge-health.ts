/**
 * gui-bridge compatibility warnings (src/main/bridge-health.ts) as sticky
 * warning toasts in the UI language. Main pushes a bare "pending" signal; the
 * window takes the warnings, so each shows in one window only, and a window
 * that mounts after the push still drains them.
 */
import type { BridgeHealthWarning } from "../../shared/ipc-types";
import { type ToastInput, toast } from "../stores/toast";
import { translate } from "./i18n";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function bridgeHealthToast(warning: BridgeHealthWarning, t: Translate): ToastInput {
	// Stays until dismissed: it explains failures the user will hit later.
	const sticky = { variant: "warning", durationMs: Number.POSITIVE_INFINITY } as const;
	if (warning.kind === "unavailable") {
		return {
			...sticky,
			title: t("bridgeHealth.unavailableTitle"),
			message: t("bridgeHealth.unavailable", { version: warning.ompVersion, reason: warning.reason }),
		};
	}
	const features = warning.features.map(feature => {
		const key = `bridgeHealth.feature.${feature}`;
		const label = t(key);
		return label === key ? feature : label;
	});
	return {
		...sticky,
		title: t("bridgeHealth.unsupportedTitle"),
		message: t("bridgeHealth.unsupported", {
			version: warning.ompVersion,
			features: features.join(t("bridgeHealth.separator")),
		}),
	};
}

/** Wire the main-process signal + boot drain once (App mount). Returns unsubscribe. */
export function subscribeBridgeHealth(): () => void {
	const drain = () => {
		void window.omp.bridgeHealth
			.take()
			.then(warnings => {
				for (const warning of warnings) toast(bridgeHealthToast(warning, translate));
			})
			.catch(() => {});
	};
	const unsubscribe = window.omp.events.onBridgeHealth(drain);
	drain();
	return unsubscribe;
}
