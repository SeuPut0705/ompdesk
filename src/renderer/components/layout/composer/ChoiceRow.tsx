/**
 * One choice among a few, as ONE line: a lead glyph, the options as a segmented row of short labels (each may carry its
 * own glyph), and the explanation behind an (i) glyph. The Run sheet's Thinking level, Tool approval and Delegation use
 * it on every surface instead of a labelled select with a caption (or stacked rows with a description each): the
 * group's name is its accessible name (`label`) and the first words of the (i) text, never a visible heading.
 *
 * The options are a `SegmentedChoice` (one tab stop, arrow keys); `selectOnArrow` picks as it moves (thinking),
 * otherwise the arrow only focuses and Enter/Space picks (approval: full access asks to confirm).
 */

import type { LucideIcon } from "lucide-react";
import { cx } from "../../../lib/format";
import { SegmentedChoice, type SegmentedOption, SettingInfo } from "../../common";

export type ChoiceOption<V extends string> = SegmentedOption<V>;

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
			<SegmentedChoice
				aria-label={label}
				className="flex-1"
				disabled={disabled}
				onChange={onChange}
				optionAttr={optionAttr}
				options={options.map(option => ({ ...option, name: option.name ?? option.label }))}
				selectOnArrow={selectOnArrow === true}
				value={held ?? null}
			/>
			{info !== undefined && <SettingInfo text={`${label}: ${info}`} />}
		</div>
	);
}
