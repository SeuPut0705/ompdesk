/**
 * Settings › General › Reply style: how long and how structured the agent's
 * replies are (prefs `outputStyle`). Every open tab follows from its next
 * turn (`useOutputStyle`); `/output-style` changes the same setting.
 */
import { PenLine } from "lucide-react";
import { useId } from "react";
import { isOutputStyleId, OUTPUT_STYLE_IDS } from "../../../../resources/gui-bridge/output-style-contracts";
import { useT } from "../../lib/i18n";
import { useOutputStyleStore } from "../../stores/output-style";
import { Select } from "../common";
import { SettingsRow } from "./SettingsLayout";

export function OutputStyleRow() {
	const t = useT();
	const id = useId();
	const style = useOutputStyleStore(state => state.style);
	const loaded = useOutputStyleStore(state => state.loaded);
	return (
		<SettingsRow
			control={
				<Select
					disabled={!loaded}
					id={id}
					onChange={event => {
						const next = event.target.value;
						if (isOutputStyleId(next)) useOutputStyleStore.getState().setStyle(next);
					}}
					options={OUTPUT_STYLE_IDS.map(value => ({ value, label: t(`settings.gui.outputStyle.${value}`) }))}
					value={style}
				/>
			}
			description={t(`settings.gui.outputStyleDesc.${style}`)}
			htmlFor={id}
			id="setting-gui-outputStyle"
			icon={<PenLine />}
			label={t("settings.gui.outputStyle")}
		/>
	);
}
