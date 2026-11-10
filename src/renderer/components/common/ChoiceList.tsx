/**
 * ChoiceList — a numbered list of full-width choice rows: the agent's questions and approvals (`PromptCard`), any
 * short list a person answers by pointing or by a number key. Each row is its number (1–9, then "·"), its label with
 * an optional `aside` after it (a "Recommended" badge) and an optional description under it; a `danger` row says a
 * destructive answer in the danger colour.
 *
 * `mode` sets what a row is: `action` (default) a plain button that answers at once; `single` a radio of a
 * `radiogroup`; `multi` a checkbox of a `group`. `selected` holds the checked keys in the two choosing modes, drawn as
 * an accent row with a filled number. Name the group with `labelledBy`.
 *
 * Keys: ↑/↓ move focus over the enabled rows and wrap at the ends (a disabled row is skipped); Enter and Space press
 * the focused row. Number keys belong to the surface around the list, because they answer from anywhere in it but a
 * text field: `PromptCard`'s `onDigit` picks row n. Rows carry `data-choice` (their key) under `data-choice-list`.
 * On a touch screen no key exists to press, so no number is drawn: an `action` row starts at its label, and a choosing
 * row keeps its box, with a ✓ in it while checked, so the check is never colour alone.
 */

import { Check } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useShellInput } from "../../hooks/use-shell-mode";
import { cx } from "../../lib/format";

export interface ChoiceListOption {
	key: string;
	label: ReactNode;
	description?: ReactNode;
	/** Shown after the label (e.g. a "Recommended" badge). */
	aside?: ReactNode;
	tone?: "default" | "danger";
	/** Unavailable right now (e.g. a field it needs is empty); arrows skip it. */
	disabled?: boolean;
}

export interface ChoiceListProps {
	choices: readonly ChoiceListOption[];
	onChoose: (key: string, index: number) => void;
	/** The checked keys, in `single` and `multi` mode. */
	selected?: ReadonlySet<string>;
	mode?: "action" | "single" | "multi";
	/** The id of the element that names the list. */
	labelledBy?: string;
}

export function ChoiceList({ choices, onChoose, selected, mode = "action", labelledBy }: ChoiceListProps) {
	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		const forward = event.key === "ArrowDown";
		if (!forward && event.key !== "ArrowUp") return;
		const group = event.currentTarget.closest<HTMLElement>("[data-choice-list]");
		const rows = Array.from(group?.querySelectorAll<HTMLButtonElement>("[data-choice]") ?? []).filter(
			row => !row.disabled,
		);
		const index = rows.indexOf(event.currentTarget);
		if (index < 0) return;
		event.preventDefault();
		rows[(index + (forward ? 1 : -1) + rows.length) % rows.length]?.focus();
	};
	const role = mode === "single" ? "radiogroup" : mode === "multi" ? "group" : undefined;
	const touch = useShellInput() === "touch";
	return (
		<div aria-labelledby={labelledBy} className="space-y-1" data-choice-list role={role}>
			{choices.map((choice, index) => {
				const checked = selected?.has(choice.key) ?? false;
				return (
					<button
						aria-checked={mode === "action" ? undefined : checked}
						className={cx(
							"group flex w-full items-start gap-3 rounded-(--sc-radius-md) border px-3 py-2 text-left transition-colors duration-(--sc-duration-fast) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--sc-focus-ring) disabled:cursor-not-allowed disabled:opacity-50",
							checked
								? "border-(--sc-accent-border) bg-(--sc-accent-soft)"
								: "border-transparent enabled:hover:bg-(--sc-hover) focus-visible:bg-(--sc-hover)",
						)}
						data-choice={choice.key}
						disabled={choice.disabled}
						key={choice.key}
						onClick={() => onChoose(choice.key, index)}
						onKeyDown={onKeyDown}
						role={mode === "single" ? "radio" : mode === "multi" ? "checkbox" : undefined}
						type="button"
					>
						{(!touch || mode !== "action") && (
							<span
								aria-hidden
								className={cx(
									"flex size-5 shrink-0 items-center justify-center rounded-(--sc-radius-sm) border text-sc-xs font-medium tabular-nums",
									checked
										? "border-(--sc-accent) bg-(--sc-accent) text-(--sc-accent-fg)"
										: "border-(--sc-border) text-(--sc-text-muted)",
								)}
							>
								{touch ? checked && <Check className="size-3.5" /> : index < 9 ? index + 1 : "·"}
							</span>
						)}
						<span className="min-w-0 flex-1">
							<span
								className={cx(
									"flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sc-md leading-5 break-keep break-words",
									choice.tone === "danger" && "text-(--sc-danger)",
								)}
							>
								{choice.label}
								{choice.aside}
							</span>
							{choice.description && (
								<span className="mt-0.5 block text-sc-sm break-keep break-words whitespace-pre-wrap text-(--sc-text-muted)">
									{choice.description}
								</span>
							)}
						</span>
					</button>
				);
			})}
		</div>
	);
}
