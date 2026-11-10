/**
 * Settings › Appearance › Theme: System first, then the light themes and the dark themes as cards, each
 * previewing its own surface, text, accent and a line of code; below them the two themes System pairs
 * (the light one for a light OS, the dark one for a dark OS). Every choice applies at once.
 */

import { Moon, Sun } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
	DARK_THEME_NAMES,
	type DarkThemeName,
	LIGHT_THEME_NAMES,
	type LightThemeName,
	type ThemeName,
} from "../../../shared/theme-names";
import { useT } from "../../lib/i18n";
import {
	applyThemeByName,
	getPersistedThemeSelection,
	getSystemThemePair,
	resolveTokenColor,
	setSystemThemePair,
	THEMES,
	type ThemeDefinition,
	type ThemeSelection,
} from "../../lib/themes";
import { useUiStore } from "../../stores/ui";
import { type ChoiceCard, ChoiceCards, Select } from "../common";
import { SettingsRow } from "./SettingsLayout";

/**
 * A theme drawn in its own colors: sidebar strip, a text line and the accent, and a line of
 * code as bars in its syntax colors. Decorative; the card carries the name.
 */
export function ThemePreview({ theme }: { theme: ThemeDefinition }) {
	const color = (key: Parameters<typeof resolveTokenColor>[1]) => resolveTokenColor(theme, key);
	return (
		<span
			aria-hidden
			className="flex h-full w-full overflow-hidden"
			data-theme-preview={theme.label}
			style={{ background: color("--omp-bg-primary") }}
		>
			<span
				className="h-full w-1/5 shrink-0"
				style={{ background: color("--omp-sidebar-bg"), borderRight: `1px solid ${color("--omp-border")}` }}
			/>
			<span className="flex min-w-0 flex-1 flex-col justify-center gap-1.5 px-2">
				<span className="flex items-center gap-1.5">
					<span className="h-1 w-1/2 rounded-(--sc-radius-full)" style={{ background: color("--omp-text") }} />
					<span className="h-1.5 w-1/4 rounded-(--sc-radius-full)" style={{ background: color("--omp-accent") }} />
				</span>
				<span className="h-1 w-2/3 rounded-(--sc-radius-full)" style={{ background: color("--omp-muted") }} />
				{/* A line of code as syntax-colored runs: they scale with the swatch, so a half-width System preview never cuts text. */}
				<span
					className="flex h-3 items-center gap-0.5 overflow-hidden rounded-(--sc-radius-sm) px-1"
					style={{ background: color("--omp-code-bg") }}
				>
					{(
						[
							["--omp-syntax-keyword", 2],
							["--omp-syntax-function", 3],
							["--omp-syntax-string", 4],
							["--omp-syntax-number", 2],
						] as const
					).map(([token, weight]) => (
						<span
							className="h-1 min-w-0 rounded-(--sc-radius-full)"
							key={token}
							style={{ background: color(token), flex: weight }}
						/>
					))}
				</span>
			</span>
		</span>
	);
}

/** The two themes System pairs, as two selects under the cards. */
function SystemThemeRows({
	pair,
	onChange,
}: {
	pair: { light: LightThemeName; dark: DarkThemeName };
	onChange: () => void;
}) {
	const t = useT();
	const lightId = useId();
	const darkId = useId();
	const options = (names: readonly ThemeName[]) =>
		names.map(name => (
			<option key={name} value={name}>
				{t(`themePicker.theme.${name}.label`)}
			</option>
		));
	return (
		<>
			<SettingsRow
				control={
					<Select
						id={lightId}
						onChange={event => {
							setSystemThemePair({ light: event.target.value as LightThemeName });
							onChange();
						}}
						value={pair.light}
					>
						{options(LIGHT_THEME_NAMES)}
					</Select>
				}
				htmlFor={lightId}
				icon={<Sun />}
				id="setting-gui-systemLightTheme"
				label={t("themePicker.systemLight")}
			/>
			<SettingsRow
				control={
					<Select
						id={darkId}
						onChange={event => {
							setSystemThemePair({ dark: event.target.value as DarkThemeName });
							onChange();
						}}
						value={pair.dark}
					>
						{options(DARK_THEME_NAMES)}
					</Select>
				}
				htmlFor={darkId}
				icon={<Moon />}
				id="setting-gui-systemDarkTheme"
				label={t("themePicker.systemDark")}
			/>
		</>
	);
}

/** Theme choice: one radio per theme, grouped by scheme; arrow keys move across the groups, a choice applies at once. */
export function ThemePicker() {
	const t = useT();
	const [current, setCurrent] = useState<ThemeSelection | null>(null);
	const [pair, setPair] = useState(getSystemThemePair);

	useEffect(() => {
		let cancelled = false;
		void getPersistedThemeSelection().then(selection => {
			if (!cancelled) setCurrent(selection);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const choose = (selection: ThemeSelection) => {
		applyThemeByName(selection);
		useUiStore.getState().setTheme(selection === "system" ? "system" : THEMES[selection].scheme);
		setCurrent(selection);
	};

	// Until the stored choice is read, the store's scheme says whether it is System (no row flashes in or out).
	const uiTheme = useUiStore(state => state.theme);
	const selected = current ?? (uiTheme === "system" ? "system" : null);
	const card = (name: ThemeName): ChoiceCard<ThemeSelection> => ({
		value: name,
		title: t(`themePicker.theme.${name}.label`),
		preview: <ThemePreview theme={THEMES[name]} />,
		tooltip: t(`themePicker.theme.${name}.description`),
	});

	return (
		<>
			<div className="scroll-mt-4 py-2" data-setting-row="true" id="setting-gui-theme">
				<ChoiceCards
					aria-label={t("settings.gui.theme")}
					gridClassName="settings-theme-grid"
					groups={[
						{
							key: "system",
							options: [
								{
									value: "system",
									title: t("themePicker.system"),
									preview: (
										<>
											<span className="w-1/2 overflow-hidden">
												<ThemePreview theme={THEMES[pair.light]} />
											</span>
											<span className="w-1/2 overflow-hidden">
												<ThemePreview theme={THEMES[pair.dark]} />
											</span>
										</>
									),
									tooltip: t("themePicker.systemDesc"),
								},
							],
						},
						{
							key: "light",
							label: t("themePicker.group.light"),
							options: LIGHT_THEME_NAMES.map(card),
							attrs: { "data-theme-group": "light" },
						},
						{
							key: "dark",
							label: t("themePicker.group.dark"),
							options: DARK_THEME_NAMES.map(card),
							attrs: { "data-theme-group": "dark" },
						},
					]}
					onChange={choose}
					optionAttr="data-theme-option"
					value={selected}
				/>
			</div>
			{selected === "system" && <SystemThemeRows onChange={() => setPair(getSystemThemePair())} pair={pair} />}
		</>
	);
}
