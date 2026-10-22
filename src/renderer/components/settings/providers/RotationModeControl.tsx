/**
 * Settings › Models & providers: how omp spreads a provider's sessions over
 * its signed-in accounts (prefs `accountRotation`, src/shared/account-rotation.ts).
 * Two choices in one segmented radio group with a line on the chosen one:
 * quota-based (stock omp, default) or even (new sessions take the accounts in
 * turn). Self-contained: it loads, saves and reports its own errors.
 *
 * The pref belongs to the machine whose omp runs the sessions: with `device`
 * (the focused tab's paired host) it reads and writes that host's own pref
 * (`host.accountRotation.*`), and says so. It is shown whatever the account
 * count — a pool can grow at any login — with a hint that it only matters
 * from two accounts on. Even is disabled when that machine's omp lacks the
 * gui-bridge `accountRotation` feature.
 */

import { useEffect, useId, useRef, useState } from "react";
import { ACCOUNT_ROTATION_MODES, type AccountRotationMode } from "../../../../shared/account-rotation";
import { useT } from "../../../lib/i18n";
import { useHostView } from "../../../stores/remote";
import { toastError } from "../../../stores/toast";
import { SegmentedChoice, Spinner } from "../../common";
import { SettingInfo } from "../../common/SettingInfo";

const LABEL_KEY: Record<AccountRotationMode, string> = {
	quota: "providers.rotation.quota",
	even: "providers.rotation.even",
};

const DESCRIPTION_KEY: Record<AccountRotationMode, string> = {
	quota: "providers.rotation.quotaDesc",
	even: "providers.rotation.evenDesc",
};

export function RotationModeControl({ device }: { device?: string }) {
	const t = useT();
	const labelId = useId();
	const hostName = useHostView(device)?.name;
	const [mode, setMode] = useState<AccountRotationMode | null>(null);
	const [evenSupported, setEvenSupported] = useState<boolean | null>(null);
	const [saving, setSaving] = useState(false);
	/** Bumped per device and per save, so a late answer for another machine or an older choice is dropped. */
	const request = useRef(0);

	useEffect(() => {
		const version = ++request.current;
		setMode(null);
		setEvenSupported(null);
		setSaving(false);
		window.omp.accountRotation
			.get(device)
			.then(state => {
				if (version !== request.current) return;
				setMode(state.mode);
				setEvenSupported(state.evenSupported);
			})
			.catch((error: unknown) => {
				if (version !== request.current) return;
				// Stock behaviour is what runs when nothing could be read.
				setMode("quota");
				toastError({ title: t("providers.rotation.loadFailed"), error });
			});
	}, [device, t]);

	const available = (option: AccountRotationMode) => option !== "even" || evenSupported !== false;

	const choose = (next: AccountRotationMode) => {
		if (!mode || next === mode || saving || !available(next)) return;
		const version = ++request.current;
		const previous = mode;
		setMode(next);
		setSaving(true);
		window.omp.accountRotation
			.set(next, device)
			.then(state => {
				if (version !== request.current) return;
				setMode(state.mode);
				setEvenSupported(state.evenSupported);
			})
			.catch((error: unknown) => {
				if (version !== request.current) return;
				setMode(previous);
				toastError({ title: t("providers.rotation.saveFailed"), error });
			})
			.finally(() => {
				if (version === request.current) setSaving(false);
			});
	};

	return (
		<div className="flex min-w-0 flex-col gap-1.5" data-account-rotation={mode ?? "loading"}>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				<span className="text-sc-md font-medium text-(--sc-text)" id={labelId}>
					{t("providers.rotation.label")}
				</span>
				{mode && <SettingInfo text={`${t(DESCRIPTION_KEY[mode])} ${t("providers.rotation.hint")}`} />}
				<SegmentedChoice
					aria-busy={saving || mode === null}
					aria-labelledby={labelId}
					disabled={mode === null}
					fit="content"
					onChange={choose}
					optionAttr="data-rotation-mode"
					options={ACCOUNT_ROTATION_MODES.map(option => ({
						value: option,
						label: t(LABEL_KEY[option]),
						disabled: !available(option),
					}))}
					value={mode}
				/>
				{(saving || mode === null) && <Spinner size="sm" spin />}
			</div>
			{device && (
				<p className="text-sc-xs text-(--sc-text-muted)">
					{t("providers.rotation.host", { name: hostName ?? t("remote.tab.unknownDevice") })}
				</p>
			)}
			{evenSupported === false && (
				<p className="text-sc-xs text-(--sc-warning)" data-rotation-unavailable="true">
					{t("providers.rotation.evenUnavailable")}
				</p>
			)}
		</div>
	);
}
