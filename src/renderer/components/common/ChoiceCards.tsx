/**
 * ChoiceCards — one value among a few options that each need a line of explanation (an MCP server's transport and
 * scope) or a picture (a theme), drawn as a grid of cards: a title, an optional icon and a muted hint. It is a radio
 * group with the keyboard model of `SegmentedChoice`: one tab stop (the held card, or the first enabled one while
 * nothing is held), arrow keys move between the enabled cards and pick as they move. A short value with no hint is a
 * `SegmentedChoice`. Name the group with `aria-label` or `aria-labelledby`.
 *
 * A card with a `preview` is a picture to pick: the preview fills a bordered frame (hidden from assistive tech, the
 * title names the card), the held one ringed in the accent with a check in its corner, the title under it on up to two
 * lines. `tooltip` says more about a card in a kit `Tooltip` (hover, keyboard focus, a long press), never as a native
 * title alone.
 *
 * `groups` splits one radio group into named parts (a theme's System, Light and Dark): each part a `SectionLabel`
 * heading over its own grid, the arrows still moving across every card in order. With `options` (one part)
 * `className` is the grid; with `groups` it is the outer column and `gridClassName` each part's grid.
 */

import { Check } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { cx } from "../../lib/format";
import { SectionLabel } from "./SectionLabel";
import { Tooltip } from "./Tooltip";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export interface ChoiceCard<V extends string> {
	value: V;
	title: ReactNode;
	hint?: ReactNode;
	icon?: ReactNode;
	/** A picture of the choice (a theme's colours), drawn in the card's frame above the title. */
	preview?: ReactNode;
	/** More about the choice, in a Tooltip on the card. */
	tooltip?: ReactNode;
	disabled?: boolean;
}

export interface ChoiceCardGroup<V extends string> {
	key: string;
	/** The part's heading; none for a part that needs no name (System above Light and Dark). */
	label?: ReactNode;
	options: readonly ChoiceCard<V>[];
	/** DOM hooks of the part's `section` (`data-theme-group="light"`). */
	attrs?: DataAttributes;
}

interface ChoiceCardsBase<V extends string> {
	value: V | null;
	onChange: (next: V) => void;
	/** Each card carries its value in this attribute (`data-mcp-transport="stdio"`) for tests and callers. */
	optionAttr: `data-${string}`;
	/** The group's id; a `FieldLabel` names it by `aria-labelledby`. */
	id?: string;
	"aria-label"?: string;
	"aria-labelledby"?: string;
	disabled?: boolean;
	className?: string;
	/** Each part's grid, with `groups`. */
	gridClassName?: string;
}

export type ChoiceCardsProps<V extends string> = ChoiceCardsBase<V> &
	({ options: readonly ChoiceCard<V>[]; groups?: never } | { groups: readonly ChoiceCardGroup<V>[]; options?: never });

const NEXT: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

const FOCUS_RING =
	"focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--sc-focus-ring) disabled:cursor-not-allowed disabled:opacity-50";

export function ChoiceCards<V extends string>({
	options,
	groups,
	value,
	onChange,
	optionAttr,
	disabled,
	className,
	gridClassName,
	...aria
}: ChoiceCardsProps<V>) {
	const all = groups ? groups.flatMap(group => group.options) : (options ?? []);
	const enabled = all.filter(option => !disabled && !option.disabled);
	const tabStop = enabled.find(option => option.value === value)?.value ?? enabled[0]?.value;

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = NEXT[event.key];
		if (step === undefined) return;
		const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=radio]"));
		const at = cards.indexOf(event.target as HTMLElement);
		const origin = at >= 0 ? all[at]?.value : value;
		event.preventDefault();
		const from = enabled.findIndex(option => option.value === origin);
		const next = enabled[(from + step + enabled.length) % enabled.length];
		if (!next) return;
		cards[all.indexOf(next)]?.focus();
		if (next.value !== value) onChange(next.value);
	};

	const card = (option: ChoiceCard<V>) => {
		const checked = option.value === value;
		const button = (
			<button
				{...{ [optionAttr]: option.value }}
				aria-checked={checked}
				className={cx(
					"min-w-0 text-left transition-colors duration-(--sc-duration-fast)",
					FOCUS_RING,
					option.preview
						? "group/choice flex flex-col gap-1.5 rounded-(--sc-radius-lg) p-1"
						: cx(
								"flex flex-col items-start gap-1 rounded-(--sc-radius-lg) border px-2.5 py-2",
								checked
									? "border-(--sc-accent) bg-(--sc-selected)"
									: "border-(--sc-border-subtle) bg-transparent enabled:hover:border-(--sc-border)",
							),
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
				{option.preview ? (
					<>
						<span
							aria-hidden
							className={cx(
								"relative flex h-20 overflow-hidden rounded-(--sc-radius-md) border",
								checked
									? "border-(--sc-accent) ring-2 ring-(--sc-accent-soft)"
									: "border-(--sc-border-subtle) group-hover/choice:border-(--sc-border)",
							)}
						>
							{option.preview}
							{checked && (
								<span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-(--sc-radius-full) bg-(--sc-accent) text-(--sc-accent-fg)">
									<Check className="size-3" strokeWidth={3} />
								</span>
							)}
						</span>
						{/* A name wraps to a second line rather than cutting off: "High Contrast Light" outgrew a tablet's card. */}
						<span className="flex items-start gap-1 px-0.5 text-sc-sm leading-snug text-(--sc-text-secondary)">
							{option.icon}
							<span className="line-clamp-2 min-w-0 break-words">{option.title}</span>
						</span>
					</>
				) : (
					<span className="flex min-w-0 items-center gap-1.5 text-sc-sm font-medium text-(--sc-text)">
						{option.icon}
						{option.title}
					</span>
				)}
				{option.hint ? (
					<span
						className={cx(
							"text-sc-xs leading-snug text-(--sc-text-muted)",
							option.preview ? "px-0.5" : undefined,
						)}
					>
						{option.hint}
					</span>
				) : null}
			</button>
		);
		return option.tooltip ? (
			<Tooltip content={option.tooltip} key={option.value}>
				{button}
			</Tooltip>
		) : (
			button
		);
	};

	if (!groups) {
		return (
			<div {...aria} className={cx("grid gap-2", className)} onKeyDown={onKeyDown} role="radiogroup">
				{all.map(card)}
			</div>
		);
	}
	return (
		<div {...aria} className={cx("flex flex-col gap-3", className)} onKeyDown={onKeyDown} role="radiogroup">
			{groups.map(group => (
				<section {...group.attrs} key={group.key}>
					{group.label ? <SectionLabel className="px-1 pb-1">{group.label}</SectionLabel> : null}
					<div className={cx("grid gap-2", gridClassName)}>{group.options.map(card)}</div>
				</section>
			))}
		</div>
	);
}
