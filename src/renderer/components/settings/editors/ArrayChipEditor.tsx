/**
 * Chip/tag editor for `string[]` settings (e.g. disabledProviders,
 * enabledModels, cycleOrder). Replaces the raw-JSON textarea for the common
 * array-of-strings shape: existing items as removable chips, an input that
 * appends on Enter/comma/blur, Backspace-on-empty removes the last chip.
 * Commits the whole array on every change (the parent writes via setSetting).
 * Ordered settings (compaction.methodOrder, images.urls.backends — TUI MultiSelectSubmenu
 * ordered parity) additionally render each chip's position and move up/down
 * controls, since their array order carries priority semantics.
 */

import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useRef, useState } from "react";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { IconButton, Input, Select } from "../../common";

export interface ArrayChipEditorProps {
	values: string[];
	onCommit: (values: string[]) => void;
	disabled?: boolean;
	placeholder?: string;
	/** When true, render positions and move up/down controls (order is meaningful). */
	ordered?: boolean;
	/** Fixed schema choices; when present, prevent arbitrary values. */
	options?: Array<{ value: string; label: string }>;
}

export function ArrayChipEditor({ values, onCommit, disabled, placeholder, ordered, options }: ArrayChipEditorProps) {
	const t = useT();
	const [draft, setDraft] = useState("");
	const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
	const availableOptions = options?.filter(option => !values.includes(option.value));

	const add = (raw: string) => {
		const items = raw
			.split(",")
			.map(s => s.trim())
			.filter(s => s.length > 0 && !values.includes(s));
		if (items.length === 0) return;
		onCommit([...values, ...items]);
		setDraft("");
	};

	const removeAt = (index: number) => {
		onCommit(values.filter((_, i) => i !== index));
	};

	const move = (index: number, delta: -1 | 1) => {
		const to = index + delta;
		if (to < 0 || to >= values.length) return;
		const next = [...values];
		next[index] = next[to];
		next[to] = values[index];
		onCommit(next);
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (isImeKeyEvent(event)) return;
		if (event.key === "Enter" || event.key === ",") {
			event.preventDefault();
			add(draft);
		} else if (event.key === "Backspace" && draft === "" && values.length > 0) {
			removeAt(values.length - 1);
		}
	};

	return (
		<div className="flex w-full flex-wrap items-center gap-1.5" onClick={() => inputRef.current?.focus()}>
			{values.map((value, index) => (
				<span
					className="inline-flex h-(--sc-control-sm) items-center gap-1 rounded-(--sc-radius-xs) bg-(--sc-surface-3) pl-2 text-sc-sm data-[disabled]:pr-2 text-(--sc-text-secondary)"
					data-disabled={disabled || undefined}
					key={`${value}-${index}`}
				>
					{ordered && <span className="text-(--sc-text-subtle) tabular-nums">{index + 1}.</span>}
					{options?.find(option => option.value === value)?.label ?? <span className="font-mono">{value}</span>}
					{ordered && !disabled && (
						<>
							<IconButton
								disabled={index === 0}
								icon={<ChevronUp />}
								label={t("settings.editors.chipMoveUp", { value })}
								onClick={e => {
									e.stopPropagation();
									move(index, -1);
								}}
								size="sm"
							/>
							<IconButton
								disabled={index === values.length - 1}
								icon={<ChevronDown />}
								label={t("settings.editors.chipMoveDown", { value })}
								onClick={e => {
									e.stopPropagation();
									move(index, 1);
								}}
								size="sm"
							/>
						</>
					)}
					{!disabled && (
						<IconButton
							icon={<X />}
							label={t("settings.editors.chipRemove", { value })}
							onClick={e => {
								e.stopPropagation();
								removeAt(index);
							}}
							size="sm"
						/>
					)}
				</span>
			))}
			{!disabled && availableOptions ? (
				<div className="min-w-[160px] flex-1">
					<Select
						aria-label={placeholder ?? t("settings.editors.chipPlaceholder")}
						controlSize="sm"
						disabled={availableOptions.length === 0}
						onChange={event => add(event.target.value)}
						ref={element => {
							inputRef.current = element;
						}}
						value=""
					>
						<option value="">{placeholder ?? t("settings.editors.chipPlaceholder")}</option>
						{availableOptions.map(option => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</Select>
				</div>
			) : !disabled ? (
				<div className="min-w-[120px] flex-1">
					<Input
						aria-label={placeholder ?? t("settings.editors.chipPlaceholder")}
						controlSize="sm"
						mono
						onBlur={() => add(draft)}
						onChange={e => setDraft(e.target.value)}
						onKeyDown={onKeyDown}
						placeholder={values.length === 0 ? (placeholder ?? t("settings.editors.chipPlaceholder")) : ""}
						ref={element => {
							inputRef.current = element;
						}}
						spellCheck={false}
						value={draft}
					/>
				</div>
			) : null}
		</div>
	);
}
