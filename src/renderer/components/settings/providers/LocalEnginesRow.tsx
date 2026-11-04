/**
 * Settings › Models & accounts › Custom endpoints: the one switch for finding FreeToken and colibri on the computer
 * whose models these are (src/main/local-engines.ts). A paired host's tab shows the host's own switch: its detector
 * writes its own models.yml, so the switch follows the list it sits under. A host too old to answer has no row.
 */
import { Radar } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../../lib/i18n";
import { toastError } from "../../../stores/toast";
import { SettingsSwitchRow } from "../SettingsLayout";

export function LocalEnginesRow({ device }: { device?: string }) {
	const t = useT();
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [unavailable, setUnavailable] = useState(false);
	const request = useRef(0);
	useEffect(() => {
		const version = ++request.current;
		setEnabled(null);
		setUnavailable(false);
		window.omp.localEngines
			.get(device)
			.then(state => {
				if (version === request.current) setEnabled(state.enabled);
			})
			.catch(() => {
				if (version === request.current) setUnavailable(true);
			});
		return () => {
			request.current++;
		};
	}, [device]);
	if (unavailable) return null;
	const choose = (next: boolean) => {
		const version = ++request.current;
		window.omp.localEngines
			.set(next, device)
			.then(state => {
				if (version === request.current) setEnabled(state.enabled);
			})
			.catch((error: unknown) => {
				if (version === request.current) toastError({ title: t("settings.saveFailed"), error });
			});
	};
	return (
		<div data-local-engine-detect>
			<SettingsSwitchRow
				checked={enabled ?? true}
				description={t("settings.models.localEnginesDesc")}
				disabled={enabled === null}
				icon={<Radar />}
				id="setting-models-localEngines"
				label={t("settings.models.localEngines")}
				onCheckedChange={choose}
			/>
		</div>
	);
}
