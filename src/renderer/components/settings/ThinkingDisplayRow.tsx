import { Brain } from "lucide-react";
import { useId } from "react";
import { saveGuiPreference, setDisplayPreference, useDisplayPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { Select } from "../common";
import { SettingsRow } from "./SettingsLayout";

const THINKING_DISPLAYS = ["hidden", "collapsed", "expanded"] as const;
type ThinkingDisplay = (typeof THINKING_DISPLAYS)[number];

/**
 * How reasoning shows, as one choice over two stored axes: whether blocks show at all (`hideThinkingBlock`, the
 * display preference ⌃T toggles, following omp's own setting until chosen) and the open state a shown block starts
 * in (`thinkingExpanded`). Hiding keeps the open state, so ⌃T brings blocks back the way they were.
 */
export function ThinkingDisplayRow() {
	const t = useT();
	const id = useId();
	const hidden = useDisplayPreference("hideThinkingBlock");
	const expanded = useUiStore(state => state.thinkingExpanded);
	const value: ThinkingDisplay = hidden ? "hidden" : expanded ? "expanded" : "collapsed";
	const choose = async (next: ThinkingDisplay) => {
		if (!(await setDisplayPreference("hideThinkingBlock", next === "hidden")) || next === "hidden") return;
		await saveGuiPreference("thinkingExpanded", next === "expanded", () =>
			useUiStore.getState().setThinkingExpanded(next === "expanded"),
		);
	};
	return (
		<SettingsRow
			control={
				<Select
					id={id}
					onChange={event => void choose(event.target.value as ThinkingDisplay)}
					options={THINKING_DISPLAYS.map(option => ({
						value: option,
						label: t(`settings.gui.thinkingDisplay.${option}`),
					}))}
					value={value}
				/>
			}
			description={t("settings.gui.thinkingDisplayDesc")}
			htmlFor={id}
			icon={<Brain />}
			id="setting-gui-thinkingDisplay"
			label={t("settings.gui.thinkingDisplay")}
		/>
	);
}
