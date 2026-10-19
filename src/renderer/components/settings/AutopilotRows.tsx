/**
 * Settings › Agent behavior › Smart automation: the two Autopilot defaults (prefs `autopilotShip`, `autopilotNotify`).
 * A change only moves what the next start does; a run keeps the settings it began with.
 * Shipping defaults to Automatic (no stored pref): main pushes the run's own branch when the repository has a remote,
 * never a release. Notifications default to stops.
 */

import { BellRing, Rocket } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
	AUTOPILOT_NOTIFY_MODES,
	AUTOPILOT_NOTIFY_PREF,
	AUTOPILOT_SHIP_PREF,
	AUTOPILOT_SHIP_PRESETS,
	type AutopilotNotifyMode,
	type AutopilotShipPolicy,
	type AutopilotShipPreset,
	DEFAULT_AUTOPILOT_SETTINGS,
	shipPolicyForPreset,
} from "../../../../resources/gui-bridge/modes/autopilot-contracts";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { Select } from "../common";
import { presetOfPolicy } from "../panels/autopilot/autopilot-view";
import { SettingsRow } from "./SettingsLayout";

/** A stored pref read once; `undefined` until it lands, `null` when nothing is stored. */
function useStoredPref(key: string): unknown {
	const [value, setValue] = useState<unknown>(undefined);
	useEffect(() => {
		let live = true;
		void window.omp.prefs.get(key).then(stored => {
			if (live) setValue(stored ?? null);
		});
		return () => {
			live = false;
		};
	}, [key]);
	return value;
}

function asPolicy(value: unknown): AutopilotShipPolicy | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as Partial<AutopilotShipPolicy>;
	return {
		autoPush: candidate.autoPush === true,
		autoRelease: {
			on: candidate.autoRelease?.on === true,
			cadence: candidate.autoRelease?.cadence ?? DEFAULT_AUTOPILOT_SETTINGS.ship.autoRelease.cadence,
		},
		remote: typeof candidate.remote === "string" && candidate.remote ? candidate.remote : "origin",
	};
}

const AUTO = "auto";
type ShipChoice = AutopilotShipPreset | typeof AUTO;

export function AutopilotShipRow() {
	const t = useT();
	const id = useId();
	const stored = useStoredPref(AUTOPILOT_SHIP_PREF);
	const [choice, setChoice] = useState<ShipChoice>(AUTO);
	useEffect(() => {
		if (stored === undefined) return;
		const policy = asPolicy(stored);
		setChoice(policy ? presetOfPolicy(policy) : AUTO);
	}, [stored]);
	const change = (next: ShipChoice) => {
		const value =
			next === AUTO
				? undefined
				: shipPolicyForPreset(next, asPolicy(stored)?.remote ?? DEFAULT_AUTOPILOT_SETTINGS.ship.remote);
		void saveGuiPreference(AUTOPILOT_SHIP_PREF, value, () => setChoice(next));
	};
	return (
		<SettingsRow
			control={
				<Select
					id={id}
					onChange={event => {
						const next = event.target.value;
						if (next === AUTO || (AUTOPILOT_SHIP_PRESETS as readonly string[]).includes(next))
							change(next as ShipChoice);
					}}
					options={[AUTO, ...AUTOPILOT_SHIP_PRESETS].map(value => ({
						value,
						label: t(`autopilot.ship.preset.${value}`),
					}))}
					value={choice}
				/>
			}
			description={t("settings.gui.autopilotShipDesc")}
			htmlFor={id}
			icon={<Rocket />}
			id="setting-gui-autopilotShip"
			label={t("settings.gui.autopilotShip")}
		/>
	);
}

export function AutopilotNotifyRow() {
	const t = useT();
	const id = useId();
	const stored = useStoredPref(AUTOPILOT_NOTIFY_PREF);
	const [mode, setMode] = useState<AutopilotNotifyMode>(DEFAULT_AUTOPILOT_SETTINGS.notify);
	useEffect(() => {
		if ((AUTOPILOT_NOTIFY_MODES as readonly unknown[]).includes(stored)) setMode(stored as AutopilotNotifyMode);
	}, [stored]);
	return (
		<SettingsRow
			control={
				<Select
					id={id}
					onChange={event => {
						const next = event.target.value as AutopilotNotifyMode;
						void saveGuiPreference(AUTOPILOT_NOTIFY_PREF, next, () => setMode(next));
					}}
					options={AUTOPILOT_NOTIFY_MODES.map(value => ({ value, label: t(`autopilot.notify.${value}`) }))}
					value={mode}
				/>
			}
			description={t("settings.gui.autopilotNotifyDesc")}
			htmlFor={id}
			icon={<BellRing />}
			id="setting-gui-autopilotNotify"
			label={t("settings.gui.autopilotNotify")}
		/>
	);
}

/** The Autopilot rows of Smart automation: shipping and notifications, nothing else. */
export function AutopilotSettingsRows() {
	return (
		<>
			<AutopilotShipRow />
			<AutopilotNotifyRow />
		</>
	);
}
