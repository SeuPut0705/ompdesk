/**
 * Theme picker: searchable overlay of the GUI's named themes plus "system".
 * Each card shows a live swatch preview from the theme's token set. Selecting
 * a theme applies it live (inline `--omp-*` tokens), persists the choice, and
 * keeps the legacy dark/light/system store coherent so the App effect and the
 * settings window stay in sync.
 */

import { Check } from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ThemeScheme } from "../../../shared/theme-names";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { listboxTarget } from "../../lib/listbox-nav";
import {
	applyThemeByName,
	getPersistedThemeSelection,
	getSystemThemePair,
	THEMES,
	type ThemeName,
	type ThemeSelection,
} from "../../lib/themes";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Modal, OptionRow, SearchField } from "../common";
import { ThemePreview } from "../settings/ThemePicker";

interface ThemeEntry {
	selection: ThemeSelection;
	group: "system" | ThemeScheme;
	label: string;
	description: string;
}

/** Catalog themes in picker order; locale keys mirror each stable theme id. */
const THEME_NAMES_IN_ORDER = Object.keys(THEMES) as ThemeName[];

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
	const listboxId = useId();

	const entries = useMemo<ThemeEntry[]>(
		() => [
			{
				selection: "system",
				group: "system",
				label: t("themePicker.system"),
				description: t("themePicker.systemDesc"),
			},
			...THEME_NAMES_IN_ORDER.map(name => ({
				selection: name,
				group: THEMES[name].scheme,
				label: t(`themePicker.theme.${name}.label`),
				description: t(`themePicker.theme.${name}.description`),
			})),
		],
		[t],
	);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return entries;
		return entries.filter(e => e.label.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
	}, [entries, query]);
	/** Consecutive entries of one group, each with its index in `filtered` (the option ids and the highlight). */
	const groups = useMemo(() => {
		const out: Array<{ group: ThemeEntry["group"]; items: Array<{ entry: ThemeEntry; i: number }> }> = [];
		filtered.forEach((entry, i) => {
			const last = out.at(-1);
			if (last?.group === entry.group) last.items.push({ entry, i });
			else out.push({ group: entry.group, items: [{ entry, i }] });
		});
		return out;
	}, [filtered]);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setQuery("");
		setActive(0);
		void getPersistedThemeSelection().then(sel => {
			if (cancelled) return;
			setCurrent(sel);
			setActive(sel === "system" ? 0 : Math.max(0, THEME_NAMES_IN_ORDER.indexOf(sel) + 1));
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
		const target = listboxTarget(e.key, active, filtered.length, { wrap: false });
		if (target !== null) {
			e.preventDefault();
			setActive(target);
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
				<div className="border-b border-(--sc-divider) p-4">
					<SearchField
						controlSize="lg"
						label={t("themePicker.search")}
						listbox={{
							id: listboxId,
							activeId: filtered.length > 0 ? `${listboxId}-option-${active}` : undefined,
						}}
						onValueChange={value => {
							setQuery(value);
							setActive(0);
						}}
						placeholder={t("themePicker.search")}
						ref={inputRef}
						value={query}
					/>
				</div>
				<div
					aria-label={t("themePicker.aria")}
					className="omp-command-list overflow-y-auto p-2"
					id={listboxId}
					ref={listRef}
					role={filtered.length > 0 ? "listbox" : undefined}
				>
					{filtered.length === 0 && (
						<div className="px-3 py-8 text-center text-sc-md text-(--sc-text-muted)">
							{t("themePicker.empty")}
						</div>
					)}
					{groups.map(group => {
						const rows = group.items.map(({ entry, i }) => {
							const isSystem = entry.selection === "system";
							const isCurrent = entry.selection === current;
							const pair = getSystemThemePair();
							return (
								<OptionRow
									key={entry.selection}
									active={i === active}
									className="gap-3"
									data-index={i}
									data-theme-entry={entry.selection}
									id={`${listboxId}-option-${i}`}
									onClick={() => select(entry)}
									onMouseDown={event => event.preventDefault()}
									onMouseEnter={() => setActive(i)}
									pointerMoves
								>
									<span
										aria-hidden="true"
										className="flex h-14 w-28 shrink-0 overflow-hidden rounded-(--sc-radius-md) border border-(--sc-border-subtle)"
									>
										{isSystem ? (
											<>
												<span className="w-1/2 overflow-hidden">
													<ThemePreview theme={THEMES[pair.light]} />
												</span>
												<span className="w-1/2 overflow-hidden">
													<ThemePreview theme={THEMES[pair.dark]} />
												</span>
											</>
										) : (
											<ThemePreview theme={THEMES[entry.selection as ThemeName]} />
										)}
									</span>
									<span className="min-w-0 flex-1">
										<span className="flex flex-wrap items-center gap-2 text-sc-md font-medium text-(--sc-text)">
											{entry.label}
											{isCurrent && (
												<>
													<Check aria-hidden className="size-(--sc-icon-sm) text-(--sc-text-secondary)" />
													<span className="sr-only">{t("tabSwitcher.current")}</span>
												</>
											)}
										</span>
										<span className="block text-sc-sm leading-relaxed text-(--sc-text-muted)">
											{entry.description}
										</span>
									</span>
								</OptionRow>
							);
						});
						if (group.group === "system") return <Fragment key="system">{rows}</Fragment>;
						const name = t(`themePicker.group.${group.group}`);
						return (
							<div aria-label={name} key={group.group} role="group">
								<div aria-hidden className="px-3 pt-3 pb-1 text-sc-xs font-medium text-(--sc-text-muted)">
									{name}
								</div>
								{rows}
							</div>
						);
					})}
				</div>
			</div>
		</Modal>
	);
}
