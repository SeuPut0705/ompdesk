/**
 * Settings › Appearance › Theme: System first, then the light themes and the dark themes as cards, each
 * previewing its own surface, text, accent and a line of code; below them the two themes System pairs
 * (the light one for a light OS, the dark one for a dark OS). Every choice applies at once.
 */

import { Check, Monitor, Moon, Sun } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
	DARK_THEME_NAMES,
	type DarkThemeName,
	LIGHT_THEME_NAMES,
	type LightThemeName,
	type ThemeName,
} from "../../../shared/theme-names";
import { cx } from "../../lib/format";
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
import { Select } from "../common";
import { SettingsRow } from "./SettingsLayout";

/** Roving-focus order of the cards: System, then the light group, then the dark group. */
const THEME_SELECTIONS: readonly ThemeSelection[] = ["system", ...LIGHT_THEME_NAMES, ...DARK_THEME_NAMES];

/**
 * A theme drawn in its own colors: sidebar strip, a text line and the accent, and a line of
 * code in its syntax colors. Decorative; the card carries the name.
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
				<span
					className="truncate rounded-(--sc-radius-sm) px-1 py-0.5 font-mono text-sc-2xs leading-none whitespace-nowrap"
					style={{ background: color("--omp-code-bg"), color: color("--omp-text") }}
				>
					<span style={{ color: color("--omp-syntax-keyword") }}>if</span>{" "}
					<span style={{ color: color("--omp-syntax-function") }}>go</span>
					<span style={{ color: color("--omp-syntax-punctuation") }}>(</span>
					<span style={{ color: color("--omp-syntax-string") }}>"a"</span>
					<span style={{ color: color("--omp-syntax-punctuation") }}>,</span>
					<span style={{ color: color("--omp-syntax-number") }}>7</span>
					<span style={{ color: color("--omp-syntax-punctuation") }}>)</span>
				</span>
			</span>
		</span>
	);
}

interface ThemeCardProps {
	selection: ThemeSelection;
	selected: boolean;
	label: string;
	title: string;
	preview: ReactNode;
	onChoose: (selection: ThemeSelection) => void;
}

function ThemeCard({ selection, selected, label, title, preview, onChoose }: ThemeCardProps) {
	return (
		<button
			aria-checked={selected}
			className="group/theme flex min-w-0 flex-col gap-1.5 rounded-(--sc-radius-lg) p-1 text-left"
			data-theme-option={selection}
			onClick={() => onChoose(selection)}
			role="radio"
			tabIndex={selected ? 0 : -1}
			title={title}
			type="button"
		>
			<span
				className={cx(
					"relative flex h-20 overflow-hidden rounded-(--sc-radius-md) border",
					selected
						? "border-(--sc-accent) ring-2 ring-(--sc-accent-soft)"
						: "border-(--sc-border-subtle) group-hover/theme:border-(--sc-border)",
				)}
			>
				{preview}
				{selected && (
					<span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-(--sc-radius-full) bg-(--sc-accent) text-(--sc-accent-fg)">
						<Check aria-hidden className="size-3" strokeWidth={3} />
					</span>
				)}
			</span>
			<span className="flex items-center gap-1 truncate px-0.5 text-sc-sm text-(--sc-text-secondary)">
				{selection === "system" && <Monitor aria-hidden className="size-(--sc-icon-sm) shrink-0" />}
				<span className="truncate">{label}</span>
			</span>
		</button>
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
				description={t("themePicker.systemLightDesc")}
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
				description={t("themePicker.systemDarkDesc")}
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
	const groupRef = useRef<HTMLDivElement>(null);

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

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		if (delta === undefined) return;
		event.preventDefault();
		const index = THEME_SELECTIONS.indexOf(current ?? "system");
		const next = THEME_SELECTIONS[
			(index + delta + THEME_SELECTIONS.length) % THEME_SELECTIONS.length
		] as ThemeSelection;
		choose(next);
		groupRef.current?.querySelector<HTMLElement>(`[data-theme-option="${next}"]`)?.focus();
	};

	const selected = current ?? "system";
	const card = (name: ThemeName) => (
		<ThemeCard
			key={name}
			label={t(`themePicker.theme.${name}.label`)}
			onChoose={choose}
			preview={<ThemePreview theme={THEMES[name]} />}
			selected={selected === name}
			selection={name}
			title={t(`themePicker.theme.${name}.description`)}
		/>
	);

	return (
		<>
			<div className="scroll-mt-4 py-2" data-setting-row="true" id="setting-gui-theme">
				<div
					aria-label={t("settings.gui.theme")}
					className="flex flex-col gap-3"
					onKeyDown={onKeyDown}
					ref={groupRef}
					role="radiogroup"
				>
					<div className="settings-theme-grid">
						<ThemeCard
							label={t("themePicker.system")}
							onChoose={choose}
							preview={
								<>
									<span className="w-1/2 overflow-hidden">
										<ThemePreview theme={THEMES[pair.light]} />
									</span>
									<span className="w-1/2 overflow-hidden">
										<ThemePreview theme={THEMES[pair.dark]} />
									</span>
								</>
							}
							selected={selected === "system"}
							selection="system"
							title={t("themePicker.systemDesc")}
						/>
					</div>
					<section data-theme-group="light">
						<h3 className="px-1 pb-1 text-sc-xs font-medium text-(--sc-text-muted)">
							{t("themePicker.group.light")}
						</h3>
						<div className="settings-theme-grid">{LIGHT_THEME_NAMES.map(card)}</div>
					</section>
					<section data-theme-group="dark">
						<h3 className="px-1 pb-1 text-sc-xs font-medium text-(--sc-text-muted)">
							{t("themePicker.group.dark")}
						</h3>
						<div className="settings-theme-grid">{DARK_THEME_NAMES.map(card)}</div>
					</section>
				</div>
			</div>
			<SystemThemeRows onChange={() => setPair(getSystemThemePair())} pair={pair} />
		</>
	);
}
