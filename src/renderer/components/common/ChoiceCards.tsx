/**
 * ChoiceCards — one value among a few options that each need a line of explanation (an MCP server's transport and
 * scope), drawn as a grid of bordered cards: a title, an optional icon and a muted hint. It is a radio group with the
 * keyboard model of `SegmentedChoice`: one tab stop (the held card, or the first enabled one while nothing is held),
 * arrow keys move between the enabled cards and pick as they move. A short value with no hint is a
 * `SegmentedChoice`; a picture to pick (a theme) keeps its own cards. Name the group with `aria-label` or
 * `aria-labelledby`.
 */

import type { KeyboardEvent, ReactNode } from "react";
import { cx } from "../../lib/format";

export interface ChoiceCard<V extends string> {
	value: V;
	title: ReactNode;
	hint?: ReactNode;
	icon?: ReactNode;
	disabled?: boolean;
}

export interface ChoiceCardsProps<V extends string> {
	options: readonly ChoiceCard<V>[];
	value: V | null;
	onChange: (next: V) => void;
	/** Each card carries its value in this attribute (`data-mcp-transport="stdio"`) for tests and callers. */
	optionAttr: `data-${string}`;
	"aria-label"?: string;
	"aria-labelledby"?: string;
	disabled?: boolean;
	className?: string;
}

const NEXT: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function ChoiceCards<V extends string>({
	options,
	value,
	onChange,
	optionAttr,
	disabled,
	className,
	...aria
}: ChoiceCardsProps<V>) {
	const enabled = options.filter(option => !disabled && !option.disabled);
	const tabStop = enabled.find(option => option.value === value)?.value ?? enabled[0]?.value;

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = NEXT[event.key];
		if (step === undefined) return;
		const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=radio]"));
		const at = cards.indexOf(event.target as HTMLElement);
		const origin = at >= 0 ? options[at]?.value : value;
		event.preventDefault();
		const from = enabled.findIndex(option => option.value === origin);
		const next = enabled[(from + step + enabled.length) % enabled.length];
		if (!next) return;
		cards[options.indexOf(next)]?.focus();
		if (next.value !== value) onChange(next.value);
	};

	return (
		<div {...aria} className={cx("grid gap-2", className)} onKeyDown={onKeyDown} role="radiogroup">
			{options.map(option => {
				const checked = option.value === value;
				return (
					<button
						{...{ [optionAttr]: option.value }}
						aria-checked={checked}
						className={cx(
							"flex min-w-0 flex-col items-start gap-1 rounded-(--sc-radius-lg) border px-2.5 py-2 text-left transition-colors duration-(--sc-duration-fast) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--sc-focus-ring) disabled:cursor-not-allowed disabled:opacity-50",
							checked
								? "border-(--sc-accent) bg-(--sc-selected)"
								: "border-(--sc-border-subtle) bg-transparent hover:border-(--sc-border)",
						)}
						disabled={disabled || option.disabled}
						key={option.value}
						onClick={() => {
							if (!checked) onChange(option.value);
						}}
						role="radio"
						tabIndex={option.value === tabStop ? 0 : -1}
						type="button"
					>
						<span className="flex min-w-0 items-center gap-1.5 text-sc-sm font-medium text-(--sc-text)">
							{option.icon}
							{option.title}
						</span>
						{option.hint ? (
							<span className="text-sc-xs leading-snug text-(--sc-text-muted)">{option.hint}</span>
						) : null}
					</button>
				);
			})}
		</div>
	);
}
