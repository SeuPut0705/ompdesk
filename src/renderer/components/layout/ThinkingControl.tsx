/**
 * Thinking level field for the composer's Run settings popover: an explicit
 * choice among every selector the ACTIVE MODEL supports — off, auto, and the
 * model's own effort ladder from get_state — never a blind cycler.
 *
 * Data comes from the model store (`thinkingConfigured`, `availableThinkingLevels`,
 * hydrated from get_state and thinking_level_changed events); selection goes
 * through `set_thinking_level`, which the agent resolves/clamps per model. The
 * receipt is authoritative and is applied directly, but only to the tab and
 * session that asked.
 */

import { useId } from "react";
import { type RpcThinkingLevelState, THINKING_LEVEL_VALUES, type ThinkingLevel } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { type ModelStore, useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { Select } from "../common";

export type ThinkingSelector = ThinkingLevel | "auto";

/** Option order: off, auto, then the model's ladder (already ascending). */
export function thinkingOptions(available: readonly ThinkingLevel[]): ThinkingSelector[] {
	// Defensive: keep only known levels, never offer a value the model rejected.
	const ladder = THINKING_LEVEL_VALUES.filter(level => level !== "off" && available.includes(level));
	return ["off", "auto", ...ladder];
}

/** The selector the composer shows: what the user configured, else the effective level. */
export function useThinkingSelector(): ThinkingSelector {
	const thinkingLevel = useModelStore(s => s.thinkingLevel);
	const configured = useModelStore(s => s.thinkingConfigured);
	return configured ?? thinkingLevel ?? "off";
}

export function ThinkingLevelField() {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const modelStore = sessionRuntimeStore<ModelStore>(tabId, "model");
	const available = useModelStore(s => s.availableThinkingLevels);
	const current = useThinkingSelector();
	const hintId = useId();

	if (available.length === 0) {
		return (
			<div className="flex flex-col gap-1.5">
				<span className="text-sc-sm font-medium text-(--sc-text)">{t("input.runSettings.thinking")}</span>
				<p className="text-sc-sm text-(--sc-text-muted)">{t("input.thinking.unsupported")}</p>
			</div>
		);
	}

	const select = (level: ThinkingSelector) => {
		const fallbackTabId = useTabsStore.getState().activeTabId;
		const fallbackSessionId = useSessionStore.getState().sessionId;
		void rpc
			.setThinkingLevel(level)
			.then(res => {
				if (!res.success) {
					toast({ variant: "error", title: t("input.thinking.failed"), message: res.error });
					return;
				}
				// The receipt is authoritative after model support / session-ceiling
				// clamps. Apply it directly so a missed/batched event cannot leave the
				// selector visually stuck on its previous value.
				const state = res.data as RpcThinkingLevelState | undefined;
				if (!state) return;
				if (
					!modelStore &&
					(useTabsStore.getState().activeTabId !== fallbackTabId ||
						useSessionStore.getState().sessionId !== fallbackSessionId)
				)
					return;
				(modelStore ?? useModelStore).setState({
					thinkingLevel: state.thinkingLevel,
					thinkingConfigured: state.thinkingConfigured,
				});
			})
			.catch(error => {
				toast({ variant: "error", title: t("input.thinking.failed"), message: String(error) });
			});
	};

	return (
		<Select
			aria-describedby={hintId}
			controlSize="sm"
			data-thinking-level
			hint={<span id={hintId}>{t(`input.thinking.level.${current}`)}</span>}
			label={t("input.runSettings.thinking")}
			onChange={event => select(event.target.value as ThinkingSelector)}
			options={thinkingOptions(available).map(option => ({
				value: option,
				label: t(`input.thinking.name.${option}`),
			}))}
			value={current}
		/>
	);
}
