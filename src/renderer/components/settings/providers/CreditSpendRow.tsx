/**
 * Settings › Models & accounts, under account rotation: the one switch for whether an account whose plan is spent
 * may go on running on ChatGPT credits or Claude extra usage (prefs `creditSpend`, src/shared/credit-spend.ts; off
 * by default). The pref belongs to the machine whose omp runs the sessions: with `device` (the focused tab's paired
 * host) it reads and writes that host's own pref. A host too old to answer has no row. Laid out as the rotation row
 * above it is: the label, what it does behind the info glyph, then the control, starting at the same left edge.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../../../lib/i18n";
import { toastError } from "../../../stores/toast";
import { SettingInfo, Switch } from "../../common";

export function CreditSpendRow({ device }: { device?: string }) {
	const t = useT();
	const labelId = useId();
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [unavailable, setUnavailable] = useState(false);
	/** Bumped per device and per save, so a late answer for another machine or an older choice is dropped. */
	const request = useRef(0);
	useEffect(() => {
		const version = ++request.current;
		setEnabled(null);
		setUnavailable(false);
		window.omp.creditSpend
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
		const previous = enabled;
		setEnabled(next);
		window.omp.creditSpend
			.set(next, device)
			.then(state => {
				if (version === request.current) setEnabled(state.enabled);
			})
			.catch((error: unknown) => {
				if (version !== request.current) return;
				setEnabled(previous);
				toastError({ title: t("settings.saveFailed"), error });
			});
	};
	return (
		<div
			className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5"
			data-credit-spend={enabled === null ? "loading" : enabled ? "on" : "off"}
		>
			<span className="text-sc-md font-medium text-(--sc-text)" id={labelId}>
				{t("providers.creditSpend.label")}
			</span>
			<SettingInfo text={t("providers.creditSpend.desc")} />
			<Switch
				aria-labelledby={labelId}
				checked={enabled ?? false}
				disabled={enabled === null}
				id="setting-models-creditSpend"
				onCheckedChange={choose}
			/>
		</div>
	);
}
