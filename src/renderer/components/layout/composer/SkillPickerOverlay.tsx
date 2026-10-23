import { Puzzle } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { oneLine } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { Kbd, LinkButton, OptionRow, SearchField } from "../../common";

/**
 * Searchable skill picker opened from the composer's + menu: one line per
 * skill (name + the description squeezed to a single ellipsized line, the full
 * text in the tooltip), ↑↓ to move, Enter to insert, Esc to close. It sits
 * directly above the input like the history overlay and never grows past 60vh.
 */

export interface SkillPickerSkill {
	/** Bare skill name (without the `skill:` prefix). */
	name: string;
	description: string;
}

interface SkillPickerOverlayProps {
	skills: readonly SkillPickerSkill[];
	onSelect: (name: string) => void;
	onManage: () => void;
	onClose: () => void;
}

/** Name matches first (prefix before substring), then description matches; token-AND. */
export function filterSkills(skills: readonly SkillPickerSkill[], query: string): SkillPickerSkill[] {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return [...skills];
	const ranked: { skill: SkillPickerSkill; rank: number }[] = [];
	for (const skill of skills) {
		const name = skill.name.toLowerCase();
		const haystack = `${name} ${oneLine(skill.description).toLowerCase()}`;
		if (!tokens.every(token => haystack.includes(token))) continue;
		const rank = tokens.every(token => name.startsWith(token))
			? 0
			: tokens.every(token => name.includes(token))
				? 1
				: 2;
		ranked.push({ skill, rank });
	}
	return ranked.sort((a, b) => a.rank - b.rank).map(entry => entry.skill);
}

export function SkillPickerOverlay({ skills, onSelect, onManage, onClose }: SkillPickerOverlayProps) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);
	const overlayRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const queryRef = useRef(query);
	queryRef.current = query;
	const listId = useId();

	const results = useMemo(() => filterSkills(skills, query), [skills, query]);
	const selected = Math.min(index, Math.max(0, results.length - 1));

	useEffect(() => {
		listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
	}, [selected]);

	// Lives above the composer rather than inside Modal: outside press closes it,
	// and Escape is consumed in capture so the app-level handler cannot abort a
	// running turn. A non-empty search clears first (SearchField), then Esc closes.
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (overlayRef.current?.contains(event.target as Node)) return;
			onClose();
		};
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isImeKeyEvent(event) || event.key !== "Escape") return;
			event.stopImmediatePropagation();
			if (queryRef.current !== "") return;
			event.preventDefault();
			onClose();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [onClose]);

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (isImeKeyEvent(event)) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setIndex(Math.min(selected + 1, Math.max(0, results.length - 1)));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setIndex(Math.max(0, selected - 1));
		} else if (event.key === "Home" && results.length > 0 && event.ctrlKey) {
			event.preventDefault();
			setIndex(0);
		} else if (event.key === "End" && results.length > 0 && event.ctrlKey) {
			event.preventDefault();
			setIndex(results.length - 1);
		} else if (event.key === "Enter") {
			event.preventDefault();
			const skill = results[selected];
			if (skill) onSelect(skill.name);
		}
	};

	return (
		<div
			aria-label={t("input.skills.title")}
			aria-modal="false"
			className="omp-pop-in absolute bottom-full left-0 z-(--sc-z-popover) mb-2 flex max-h-[60vh] w-[min(440px,100%)] flex-col overflow-hidden rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) shadow-(--sc-shadow-md)"
			data-skill-picker
			ref={overlayRef}
			role="dialog"
		>
			<div className="border-b border-(--sc-divider) p-1.5">
				<SearchField
					listbox={{ id: listId, activeId: results.length > 0 ? `${listId}-option-${selected}` : undefined }}
					autoFocus
					controlSize="sm"
					label={t("input.skills.searchLabel")}
					onKeyDown={handleKeyDown}
					onValueChange={value => {
						setQuery(value);
						setIndex(0);
					}}
					placeholder={t("input.skills.placeholder")}
					value={query}
				/>
			</div>
			<div
				aria-label={t("input.skills.title")}
				className="min-h-0 flex-1 overflow-y-auto p-1"
				id={listId}
				ref={listRef}
				role={results.length > 0 ? "listbox" : undefined}
			>
				{results.length === 0 ? (
					<div className="px-3 py-2.5 text-sc-sm text-(--sc-text-muted)">
						{skills.length === 0 ? t("input.skills.none") : t("input.skills.noMatch")}
					</div>
				) : (
					results.map((skill, rowIndex) => {
						const description = oneLine(skill.description);
						return (
							<OptionRow
								pointerMoves
								active={rowIndex === selected}
								className="gap-3 rounded-(--sc-radius-sm)"
								data-index={rowIndex}
								data-skill-row={skill.name}
								id={`${listId}-option-${rowIndex}`}
								key={skill.name}
								onClick={() => onSelect(skill.name)}
								onMouseDown={event => event.preventDefault()}
								onMouseEnter={() => setIndex(rowIndex)}
								size="sm"
								title={description ? `${skill.name}\n${description}` : skill.name}
							>
								<span className="max-w-[55%] shrink-0 truncate font-mono text-sc-sm font-medium text-(--sc-text)">
									{skill.name}
								</span>
								{description && (
									<span
										className="min-w-0 flex-1 truncate text-sc-xs text-(--sc-text-muted)"
										data-skill-description
									>
										{description}
									</span>
								)}
							</OptionRow>
						);
					})
				)}
			</div>
			<div className="flex items-center gap-3 border-t border-(--sc-divider) px-2 py-1 text-sc-2xs text-(--sc-text-muted)">
				<span className="flex shrink-0 items-center gap-1 max-sm:hidden">
					<Kbd shortcut="↑" />
					<Kbd shortcut="↓" />
					{t("palette.hintMove")}
				</span>
				<span className="flex shrink-0 items-center gap-1 max-sm:hidden">
					<Kbd shortcut="↵" />
					{t("input.skills.hintInsert")}
				</span>
				<LinkButton
					className="ml-auto inline-flex min-w-0 items-center gap-1 px-1.5 py-0.5 text-sc-2xs"
					data-skill-manage
					onClick={onManage}
					tone="muted"
				>
					<Puzzle aria-hidden className="size-3 shrink-0" />
					<span className="truncate">{t("input.addMenu.manage")}</span>
				</LinkButton>
			</div>
		</div>
	);
}
