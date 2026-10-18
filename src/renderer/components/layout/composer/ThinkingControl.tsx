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
import { type RpcThinkingLevelState, THINKING_LEVEL_VALUES, type ThinkingLevel } from "../../../../shared/rpc-types";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { type ModelStore, useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { toastError } from "../../../stores/toast";
import { Select } from "../../common";

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

/** `select`: the labelled Select of the Run popover; `segmented`: one radio row (the model picker's effort row). */
export function ThinkingLevelField({ variant = "select" }: { variant?: "select" | "segmented" }) {
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
					toastError({ title: t("input.thinking.failed"), error: res });
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
				// A new pick starts over: auto names its effort again after the next turn.
				(modelStore ?? useModelStore).setState({
					thinkingLevel: state.thinkingLevel,
					thinkingConfigured: state.thinkingConfigured,
					thinkingAutoResolved: undefined,
				});
			})
			.catch(error => {
				toastError({ title: t("input.thinking.failed"), error });
			});
	};

	const options = thinkingOptions(available);
	if (variant === "segmented") {
		return (
			<div className="flex flex-col gap-1.5" data-thinking-level>
				<span className="text-sc-sm font-medium text-(--sc-text)" id={`${hintId}-label`}>
					{t("input.runSettings.thinking")}
				</span>
				<div
					aria-labelledby={`${hintId}-label`}
					className="flex w-full items-center gap-0.5 rounded-(--sc-radius-md) bg-(--sc-surface-3) p-0.5"
					onKeyDown={event => {
						if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
						event.preventDefault();
						const step = event.key === "ArrowRight" ? 1 : -1;
						const next = options[(options.indexOf(current) + step + options.length) % options.length];
						if (!next) return;
						select(next);
						event.currentTarget.querySelector<HTMLElement>(`[data-thinking-option="${next}"]`)?.focus();
					}}
					role="radiogroup"
				>
					{options.map(option => (
						<button
							aria-checked={option === current}
							className={cx(
								"h-(--sc-hit-min) min-w-0 flex-1 truncate rounded-(--sc-radius-sm) px-1.5 text-sc-sm font-medium whitespace-nowrap transition-colors duration-(--sc-duration-fast)",
								option === current
									? "bg-(--sc-elevated) text-(--sc-text) shadow-(--sc-shadow-sm)"
									: "text-(--sc-text-muted) hover:text-(--sc-text)",
							)}
							data-thinking-option={option}
							key={option}
							onClick={() => select(option)}
							role="radio"
							tabIndex={option === current ? 0 : -1}
							type="button"
						>
							{t(`input.thinking.name.${option}`)}
						</button>
					))}
				</div>
				<span className="text-sc-xs text-(--sc-text-muted)" id={hintId}>
					{t(`input.thinking.level.${current}`)}
				</span>
			</div>
		);
	}

	return (
		<Select
			aria-describedby={hintId}
			controlSize="sm"
			data-thinking-level
			hint={<span id={hintId}>{t(`input.thinking.level.${current}`)}</span>}
			label={t("input.runSettings.thinking")}
			onChange={event => select(event.target.value as ThinkingSelector)}
			options={options.map(option => ({
				value: option,
				label: t(`input.thinking.name.${option}`),
			}))}
			value={current}
		/>
	);
}
