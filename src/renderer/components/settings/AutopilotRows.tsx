/**
 * Settings › Agent behavior › Smart automation: the Autopilot defaults the start sheet opens with. The sheet reads them
 * (prefs `autopilotShip`, `autopilotNotify`, `autopilotLimits`) and sends its own values, so a change here only moves
 * what the next start proposes; a run keeps the settings it began with (its screen changes them while it runs).
 * Everything defaults to the cautious side: local only, every ceiling off, notifications on stops.
 */

import { BellRing, Gauge, Rocket } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
	AUTOPILOT_LIMITS_PREF,
	AUTOPILOT_NOTIFY_MODES,
	AUTOPILOT_NOTIFY_PREF,
	AUTOPILOT_SHIP_PREF,
	AUTOPILOT_SHIP_PRESETS,
	type AutopilotNotifyMode,
	type AutopilotShipPolicy,
	type AutopilotShipPreset,
	DEFAULT_AUTOPILOT_SETTINGS,
	NO_LIMITS,
	shipPolicyForPreset,
} from "../../../../resources/gui-bridge/modes/autopilot-contracts";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { Input, Select } from "../common";
import { limitsFromText, presetOfPolicy } from "../panels/autopilot/autopilot-view";
import { SettingsRow } from "./SettingsLayout";

/** A stored pref read once; `undefined` until it lands. */
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

function asPolicy(value: unknown): AutopilotShipPolicy {
	if (typeof value !== "object" || value === null) return DEFAULT_AUTOPILOT_SETTINGS.ship;
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

export function AutopilotShipRow() {
	const t = useT();
	const id = useId();
	const stored = useStoredPref(AUTOPILOT_SHIP_PREF);
	const [preset, setPreset] = useState<AutopilotShipPreset>("local");
	useEffect(() => {
		if (stored !== undefined) setPreset(presetOfPolicy(asPolicy(stored)));
	}, [stored]);
	const change = (next: AutopilotShipPreset) => {
		const current = asPolicy(stored);
		const policy = shipPolicyForPreset(next, current.remote);
		void saveGuiPreference(
			AUTOPILOT_SHIP_PREF,
			{ ...policy, autoRelease: { ...policy.autoRelease, cadence: current.autoRelease.cadence } },
			() => setPreset(next),
		);
	};
	return (
		<SettingsRow
			control={
				<Select
					id={id}
					onChange={event => {
						const next = event.target.value;
						if ((AUTOPILOT_SHIP_PRESETS as readonly string[]).includes(next)) change(next as AutopilotShipPreset);
					}}
					options={AUTOPILOT_SHIP_PRESETS.map(value => ({ value, label: t(`autopilot.ship.preset.${value}`) }))}
					value={preset}
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

const LIMIT_KEYS = ["tokens", "minutes", "cycles", "usd"] as const;

export function AutopilotLimitsRow() {
	const t = useT();
	const stored = useStoredPref(AUTOPILOT_LIMITS_PREF);
	const [text, setText] = useState({ tokens: "", minutes: "", cycles: "", usd: "" });
	useEffect(() => {
		if (typeof stored !== "object" || stored === null) return;
		const record = stored as Record<string, unknown>;
		const field = (key: string) => (typeof record[key] === "number" ? String(record[key]) : "");
		setText({ tokens: field("tokens"), minutes: field("minutes"), cycles: field("cycles"), usd: field("usd") });
	}, [stored]);
	const save = (next: typeof text) => {
		const limits = limitsFromText(next);
		const allOff = LIMIT_KEYS.every(key => limits[key] === NO_LIMITS[key]);
		void saveGuiPreference(AUTOPILOT_LIMITS_PREF, allOff ? undefined : limits, () => {});
	};
	return (
		<SettingsRow
			description={t("settings.gui.autopilotLimitsDesc")}
			icon={<Gauge />}
			id="setting-gui-autopilotLimits"
			label={t("settings.gui.autopilotLimits")}
		>
			<div className="grid grid-cols-2 gap-2 pt-1.5 sm:grid-cols-4">
				{LIMIT_KEYS.map(key => (
					<Input
						controlSize="sm"
						key={key}
						label={t(`autopilot.limit.${key}`)}
						min={0}
						onBlur={() => save(text)}
						onChange={event => setText(current => ({ ...current, [key]: event.target.value }))}
						placeholder={t("autopilot.limit.off")}
						type="number"
						value={text[key]}
					/>
				))}
			</div>
		</SettingsRow>
	);
}
