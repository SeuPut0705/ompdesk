import { type KeyboardEvent, type Ref, useImperativeHandle, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { Kbd } from "../common/Kbd";

/** The most chips the composer shows (and the most Alt+N digits it answers). */
export const MAX_NEXT_PROMPT_CHIPS = 3;

/** Alt+1..3 by physical key: macOS ⌥ composes characters, so `event.key` is no help. */
export function chipIndexForCode(code: string | undefined): number | undefined {
	const match = code ? /^Digit([1-3])$/.exec(code) : null;
	return match ? Number(match[1]) - 1 : undefined;
}

export interface NextPromptChipsHandle {
	/** Move focus onto the first chip (↓ from the empty composer). */
	focusFirst(): void;
}

interface NextPromptChipsProps {
	chips: readonly string[];
	/** A chip was chosen (click, Enter, Space, Alt+N while focused). */
	onPick(text: string, index: number): void;
	/** Esc / ↑ on a chip: back to the composer without filling it. */
	onReturn(): void;
	handleRef?: Ref<NextPromptChipsHandle>;
}

/**
 * The runner-up suggestions as one row of small buttons above the composer box.
 * One tab stop (roving tabindex): ←/→ move between chips, Enter/Space/click fill
 * the composer, Esc/↑ hand focus back. Each chip truncates to a max width; its
 * full text is the title and the accessible name.
 */
export function NextPromptChips({ chips, onPick, onReturn, handleRef }: NextPromptChipsProps) {
	const t = useT();
	const buttons = useRef<(HTMLButtonElement | null)[]>([]);
	const [active, setActive] = useState(0);
	const visible = chips.slice(0, MAX_NEXT_PROMPT_CHIPS);
	const current = Math.min(active, Math.max(0, visible.length - 1));

	const focusChip = (index: number) => {
		setActive(index);
		buttons.current[index]?.focus();
	};
	useImperativeHandle(
		handleRef,
		() => ({
			focusFirst: () => {
				setActive(0);
				buttons.current[0]?.focus();
			},
		}),
		[],
	);

	const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
		if (isImeKeyEvent(event)) return;
		const plain = !event.ctrlKey && !event.metaKey && !event.shiftKey;
		if (event.altKey && plain) {
			const target = chipIndexForCode(event.code);
			const text = target === undefined ? undefined : visible[target];
			if (target !== undefined && text !== undefined) {
				event.preventDefault();
				onPick(text, target);
			}
			return;
		}
		if (!plain || event.altKey) return;
		const last = visible.length - 1;
		const next =
			event.key === "ArrowRight"
				? Math.min(last, index + 1)
				: event.key === "ArrowLeft"
					? Math.max(0, index - 1)
					: event.key === "Home"
						? 0
						: event.key === "End"
							? last
							: undefined;
		if (next !== undefined) {
			event.preventDefault();
			focusChip(next);
			return;
		}
		if (event.key === "Escape" || event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			onReturn();
		}
	};

	if (visible.length === 0) return null;
	return (
		<div aria-label={t("input.chips.label")} className="omp-next-chips" role="group">
			{visible.map((text, index) => (
				<button
					aria-keyshortcuts={`Alt+${index + 1}`}
					aria-label={t("input.chips.chip", { index: index + 1, text })}
					className="omp-next-chip"
					data-next-chip={index}
					key={`${index}:${text}`}
					onClick={() => onPick(text, index)}
					onFocus={() => setActive(index)}
					onKeyDown={event => onKeyDown(event, index)}
					ref={element => {
						buttons.current[index] = element;
					}}
					tabIndex={index === current ? 0 : -1}
					title={text}
					type="button"
				>
					<span className="omp-next-chip-text">{text}</span>
					<Kbd shortcut={`⌥${index + 1}`} />
				</button>
			))}
		</div>
	);
}
