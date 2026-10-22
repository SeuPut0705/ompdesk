/**
 * SegmentedChoice — one value among 2–5 short options, picked in place: a radio group drawn as a segmented track
 * (the held option raised). The value applies at once, like a Switch; a long or rich list is a Select or a picker.
 * Tabs look alike but switch views; this sets a value.
 *
 * One tab stop: the held option (or, while nothing is held yet, the first enabled one). Arrow keys move between the
 * enabled options; `selectOnArrow` (default) picks as it moves, otherwise Enter or Space picks the focused one (a
 * choice that asks to confirm, such as full access). Name the group with `aria-label` or `aria-labelledby`.
 *
 * `fit`: `auto` gives each segment its label's width plus an even share of the rest (a long short label keeps its
 * room), `equal` equal widths, `content` segments as wide as their labels and the track as wide as they are.
 * Each segment carries its value in `optionAttr` (`data-approval-option="ask"`) for tests and callers.
 */

import type { LucideIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
import { cx } from "../../lib/format";

export interface SegmentedOption<V extends string> {
	value: V;
	/** The text shown in the segment. */
	label: string;
	/** The full name: the segment's accessible name and tooltip; defaults to `label`. */
	name?: string;
	icon?: LucideIcon;
	disabled?: boolean;
}

export interface SegmentedChoiceProps<V extends string> {
	options: readonly SegmentedOption<V>[];
	/** The held value; null while it is not known yet. */
	value: V | null;
	onChange: (next: V) => void;
	optionAttr: `data-${string}`;
	"aria-label"?: string;
	"aria-labelledby"?: string;
	"aria-busy"?: boolean;
	disabled?: boolean;
	selectOnArrow?: boolean;
	fit?: "auto" | "equal" | "content";
	className?: string;
}

const NEXT: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

const SEGMENT: Record<NonNullable<SegmentedChoiceProps<string>["fit"]>, string> = {
	auto: "min-w-0 flex-auto px-1",
	equal: "min-w-0 flex-1 px-1.5",
	content: "shrink-0 px-2.5",
};

export function SegmentedChoice<V extends string>({
	options,
	value,
	onChange,
	optionAttr,
	disabled,
	selectOnArrow = true,
	fit = "auto",
	className,
	...aria
}: SegmentedChoiceProps<V>) {
	const enabled = options.filter(option => !disabled && !option.disabled);
	const held = options.find(option => option.value === value);
	// A disabled button takes no focus: a held option that is disabled hands the tab stop to the first enabled one.
	const tabStop = enabled.find(option => option.value === held?.value)?.value ?? enabled[0]?.value;

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = NEXT[event.key];
		if (step === undefined) return;
		const segments = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=radio]"));
		// From the focused segment, else (the group itself has the key) from the held value.
		const at = segments.indexOf(event.target as HTMLElement);
		const origin = at >= 0 ? options[at]?.value : value;
		event.preventDefault();
		const from = enabled.findIndex(option => option.value === origin);
		const next = enabled[(from + step + enabled.length) % enabled.length];
		if (!next) return;
		segments[options.indexOf(next)]?.focus();
		if (selectOnArrow && next.value !== value) onChange(next.value);
	};

	return (
		<div
			{...aria}
			className={cx(
				"items-center gap-0.5 rounded-(--sc-radius-md) bg-(--sc-surface-3) p-0.5",
				fit === "content" ? "inline-flex" : "flex min-w-0",
				className,
			)}
			onKeyDown={onKeyDown}
			role="radiogroup"
		>
			{options.map(option => {
				const OptionIcon = option.icon;
				const checked = option.value === held?.value;
				const name = option.name ?? option.label;
				return (
					<button
						{...{ [optionAttr]: option.value }}
						aria-checked={checked}
						aria-label={option.name === undefined ? undefined : name}
						className={cx(
							"flex h-(--sc-hit-min) items-center justify-center gap-1 rounded-(--sc-radius-sm) text-sc-sm font-medium whitespace-nowrap transition-colors duration-(--sc-duration-fast) disabled:cursor-not-allowed disabled:opacity-50",
							SEGMENT[fit],
							checked
								? "bg-(--sc-elevated) text-(--sc-text) shadow-(--sc-shadow-sm)"
								: "text-(--sc-text-muted) hover:text-(--sc-text)",
						)}
						disabled={disabled || option.disabled}
						key={option.value}
						onClick={() => {
							if (!checked) onChange(option.value);
						}}
						role="radio"
						tabIndex={option.value === tabStop ? 0 : -1}
						title={option.name === undefined ? undefined : name}
						type="button"
					>
						{OptionIcon && <OptionIcon aria-hidden className="size-(--sc-icon-sm) shrink-0" />}
						<span className="min-w-0 truncate">{option.label}</span>
					</button>
				);
			})}
		</div>
	);
}
