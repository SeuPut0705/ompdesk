/**
 * One choice among a few, as ONE line: a lead glyph, the options as a segmented row of short labels (each may carry its
 * own glyph), and the explanation behind an (i) glyph. The Run sheet's Thinking level, Tool approval and Delegation use
 * it on every surface instead of a labelled select with a caption (or stacked rows with a description each): the
 * group's name is its accessible name (`label`) and the first words of the (i) text, never a visible heading.
 *
 * A radio group with one tab stop (the held option). Arrows move between the options; `selectOnArrow` picks as it
 * moves (thinking), otherwise the arrow only focuses and Enter/Space picks (approval: full access asks to confirm).
 */

import type { LucideIcon } from "lucide-react";
import { cx } from "../../../lib/format";
import { SettingInfo } from "../../common";

export interface ChoiceOption<V extends string> {
	value: V;
	/** The short label shown in the segment. */
	label: string;
	/** The full name (the segment's accessible name and tooltip); defaults to `label`. */
	name?: string;
	icon?: LucideIcon;
}

export interface ChoiceRowProps<V extends string> {
	/** The lead glyph naming the group. */
	icon: LucideIcon;
	/** The group's name: the radiogroup's accessible name and the start of the (i) text. */
	label: string;
	/** The explanation of the held option (and anything the group needs to say once). */
	info?: string;
	options: readonly ChoiceOption<V>[];
	value: V;
	onChange: (next: V) => void;
	disabled?: boolean;
	selectOnArrow?: boolean;
	/** The attribute each segment carries its value in (`data-approval-option`), for tests and callers. */
	optionAttr: `data-${string}`;
	/** Attributes of the row itself (`data-approval-mode`). */
	rowAttrs?: Record<`data-${string}`, string | boolean>;
	className?: string;
}

export function ChoiceRow<V extends string>({
	icon: Icon,
	label,
	info,
	options,
	value,
	onChange,
	disabled,
	selectOnArrow,
	optionAttr,
	rowAttrs,
	className,
}: ChoiceRowProps<V>) {
	const held = options.some(option => option.value === value) ? value : options[0]?.value;
	return (
		<div
			className={cx("flex min-h-(--sc-control-md) min-w-0 items-center gap-2 py-0.5", className)}
			data-choice-row
			{...rowAttrs}
		>
			<span
				aria-hidden
				className="flex size-(--sc-icon-md) shrink-0 items-center justify-center text-(--sc-text-muted)"
				data-setting-icon
			>
				<Icon className="size-(--sc-icon-md)" />
			</span>
			<div
				aria-label={label}
				className="flex min-w-0 flex-1 items-center gap-0.5 rounded-(--sc-radius-md) bg-(--sc-surface-3) p-0.5"
				onKeyDown={event => {
					const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
					if (!keys.includes(event.key)) return;
					const segments = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=radio]"));
					const index = segments.indexOf(event.target as HTMLElement);
					if (index < 0) return;
					event.preventDefault();
					const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
					const next = segments[(index + step + segments.length) % segments.length];
					if (!next) return;
					next.focus();
					if (selectOnArrow && !disabled) next.click();
				}}
				role="radiogroup"
			>
				{options.map(option => {
					const OptionIcon = option.icon;
					const checked = option.value === held;
					const name = option.name ?? option.label;
					return (
						<button
							{...{ [optionAttr]: option.value }}
							aria-checked={checked}
							aria-label={name}
							className={cx(
								"flex h-(--sc-hit-min) min-w-0 flex-1 items-center justify-center gap-1 rounded-(--sc-radius-sm) px-1 text-sc-sm font-medium whitespace-nowrap transition-colors duration-(--sc-duration-fast) disabled:cursor-not-allowed disabled:opacity-60",
								checked
									? "bg-(--sc-elevated) text-(--sc-text) shadow-(--sc-shadow-sm)"
									: "text-(--sc-text-muted) hover:text-(--sc-text)",
							)}
							disabled={disabled}
							key={option.value}
							onClick={() => {
								if (!checked) onChange(option.value);
							}}
							role="radio"
							tabIndex={checked ? 0 : -1}
							title={name}
							type="button"
						>
							{OptionIcon && <OptionIcon aria-hidden className="size-(--sc-icon-sm) shrink-0" />}
							<span className="min-w-0 truncate">{option.label}</span>
						</button>
					);
				})}
			</div>
			{info !== undefined && <SettingInfo text={`${label}: ${info}`} />}
		</div>
	);
}
