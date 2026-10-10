/**
 * Theme picker: searchable overlay of the GUI's named themes plus "system".
 * Each card shows a live swatch preview from the theme's token set. Selecting
 * a theme applies it live (inline `--omp-*` tokens), persists the choice, and
 * keeps the legacy dark/light/system store coherent so the App effect and the
 * settings window stay in sync.
 */

import { Check, Monitor, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import {
	applyThemeByName,
	getPersistedThemeSelection,
	resolveTokenColor,
	THEMES,
	type ThemeName,
	type ThemeSelection,
} from "../../lib/themes";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Modal } from "../common";

const SWATCH_KEYS = ["--omp-accent", "--omp-syntax-string", "--omp-syntax-function", "--omp-syntax-number"] as const;

interface ThemeEntry {
	selection: ThemeSelection;
	label: string;
	description: string;
}

/** Catalog themes; locale keys mirror each stable theme selection id. */
const THEME_ENTRIES: ThemeEntry[] = (Object.keys(THEMES) as ThemeName[]).map(name => ({
	selection: name as ThemeSelection,
	label: THEMES[name].label,
	description: THEMES[name].description ?? "",
}));

export function ThemePickerDialog() {
	const t = useT();
	const open = useUiStore(s => s.themePickerOpen);
	const close = useUiStore(s => s.closeThemePicker);
	const setTheme = useUiStore(s => s.setTheme);

	const [query, setQuery] = useState("");
	const [current, setCurrent] = useState<ThemeSelection>("system");
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const entries = useMemo<ThemeEntry[]>(
		() => [
			{ selection: "system", label: t("themePicker.system"), description: t("themePicker.systemDesc") },
			...THEME_ENTRIES.map(entry => ({
				...entry,
				label: t(`themePicker.theme.${entry.selection}.label`),
				description: t(`themePicker.theme.${entry.selection}.description`),
			})),
		],
		[t],
	);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return entries;
		return entries.filter(e => e.label.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
	}, [entries, query]);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setQuery("");
		setActive(0);
		void getPersistedThemeSelection().then(sel => {
			if (cancelled) return;
			setCurrent(sel);
			const themeIndex = THEME_ENTRIES.findIndex(e => e.selection === sel);
			setActive(sel === "system" ? 0 : Math.max(0, themeIndex + 1));
		});
		requestAnimationFrame(() => inputRef.current?.focus());
		return () => {
			cancelled = true;
		};
	}, [open]);

	const select = (entry: ThemeEntry) => {
		const sel = entry.selection;
		applyThemeByName(sel);
		setTheme(sel === "system" ? "system" : THEMES[sel].scheme);
		setCurrent(sel);
		toast({ variant: "success", message: t("themePicker.applied", { name: entry.label }) });
		close();
	};

	const onKey = (e: React.KeyboardEvent) => {
		if (isImeKeyEvent(e)) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive(i => Math.min(filtered.length - 1, i + 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive(i => Math.max(0, i - 1));
		} else if (e.key === "Enter") {
			e.preventDefault();
			const entry = filtered[active];
			if (entry) select(entry);
		}
	};

	useEffect(() => {
		listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	return (
		<Modal
			open={open}
			onClose={close}
			chromeless
			ariaLabel={t("themePicker.aria")}
			size="picker"
			placement="top"
			bodyClassName="p-0"
		>
			<div onKeyDown={onKey}>
				<div className="flex min-h-16 items-center gap-2.5 border-b border-(--sc-divider) px-4 py-3">
					<Search aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-text-muted)" />
					<input
						aria-label={t("themePicker.search")}
						ref={inputRef}
						value={query}
						onChange={e => {
							setQuery(e.target.value);
							setActive(0);
						}}
						placeholder={t("themePicker.search")}
						className="min-w-0 flex-1 rounded-(--sc-radius-sm) bg-transparent text-sc-lg text-(--sc-text) placeholder:text-(--sc-text-subtle)"
					/>
				</div>
				<div ref={listRef} className="omp-command-list overflow-y-auto p-2">
					{filtered.length === 0 && (
						<div className="px-3 py-8 text-center text-sc-md text-(--sc-text-muted)">
							{t("themePicker.empty")}
						</div>
					)}
					{filtered.map((entry, i) => {
						const isSystem = entry.selection === "system";
						const theme = isSystem ? null : THEMES[entry.selection as ThemeName];
						const isCurrent = entry.selection === current;
						return (
							<button
								key={entry.selection}
								type="button"
								data-index={i}
								aria-pressed={isCurrent}
								onClick={() => select(entry)}
								onMouseEnter={() => setActive(i)}
								className={cx(
									"flex min-h-10 w-full items-center gap-3 rounded-(--sc-radius-md) px-3 py-2.5 text-left",
									i === active ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)",
								)}
							>
								<span
									aria-hidden="true"
									className="flex h-14 w-24 shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-(--sc-radius-md) border"
									style={{
										background: theme ? resolveTokenColor(theme, "--omp-bg-primary") : "var(--sc-surface-2)",
										borderColor: theme ? resolveTokenColor(theme, "--omp-border") : "var(--sc-border-subtle)",
										color: theme ? resolveTokenColor(theme, "--omp-text") : "var(--sc-text)",
									}}
								>
									{isSystem ? (
										<span className="flex h-full w-full items-center justify-center text-(--sc-text-muted)">
											<Monitor className="size-(--sc-icon-md)" />
										</span>
									) : (
										<>
											<span className="font-display text-sc-xl font-medium">Aa</span>
											<span className="flex gap-1">
												{SWATCH_KEYS.map(key => (
													<span
														key={key}
														className="h-1.5 w-3 rounded-full"
														style={{ background: resolveTokenColor(theme!, key) }}
													/>
												))}
											</span>
										</>
									)}
								</span>
								<span className="min-w-0 flex-1">
									<span className="flex flex-wrap items-center gap-2 text-sc-md font-medium text-(--sc-text)">
										{entry.label}
										{isCurrent && (
											<Check aria-hidden className="size-(--sc-icon-sm) text-(--sc-text-secondary)" />
										)}
									</span>
									<span className="block text-sc-sm leading-relaxed text-(--sc-text-muted)">
										{entry.description}
									</span>
								</span>
							</button>
						);
					})}
				</div>
			</div>
		</Modal>
	);
}
