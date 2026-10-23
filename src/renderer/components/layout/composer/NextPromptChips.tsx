import {
	Fragment,
	type KeyboardEvent,
	type MouseEvent,
	type Ref,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { Kbd } from "../../common/Kbd";

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
	/** Touch: one sideways-scrolling row with no key hints; a long press on a chip offers "send now". */
	touch?: boolean;
	/** Touch "send now" (the chip's text goes out unedited). */
	onSend?(text: string): void;
	/**
	 * The draft is not empty (or a menu is open): the row keeps its place but is hidden and inert, so typing the first
	 * character never changes the transcript's height (the row used to unmount: the viewport grew by its 36 px).
	 */
	away?: boolean;
}

/**
 * The runner-up suggestions as one row of small buttons above the composer box.
 * One tab stop (roving tabindex): ←/→ move between chips, Enter/Space/click fill
 * the composer, Esc/↑ hand focus back. Each chip truncates to a max width; its
 * full text is the title and the accessible name.
 */
export function NextPromptChips({
	chips,
	onPick,
	onReturn,
	handleRef,
	touch = false,
	onSend,
	away = false,
}: NextPromptChipsProps) {
	const t = useT();
	const buttons = useRef<(HTMLButtonElement | null)[]>([]);
	const [active, setActive] = useState(0);
	const visible = chips.slice(0, MAX_NEXT_PROMPT_CHIPS);
	const current = Math.min(active, Math.max(0, visible.length - 1));
	/** Touch: the chip a long press armed; its "send now" button sits right after it. */
	const [armed, setArmed] = useState<number | null>(null);
	useEffect(() => {
		if (armed === null) return;
		const dismiss = (event: Event) => {
			if (!(event.target as Element | null)?.closest?.("[data-next-chip-send]")) setArmed(null);
		};
		document.addEventListener("pointerdown", dismiss, true);
		return () => document.removeEventListener("pointerdown", dismiss, true);
	}, [armed]);

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
		<div
			aria-hidden={away || undefined}
			aria-label={t("input.chips.label")}
			className="omp-next-chips"
			data-away={away || undefined}
			data-touch={touch || undefined}
			inert={away || undefined}
			role="group"
		>
			{visible.map((text, index) => (
				<Fragment key={`${index}:${text}`}>
					{/* controls-ok: the omp-next-chip class draws the whole control */}
					<button
						aria-keyshortcuts={touch ? undefined : `Alt+${index + 1}`}
						aria-label={t("input.chips.chip", { index: index + 1, text })}
						className="omp-next-chip"
						data-next-chip={index}
						onClick={() => {
							setArmed(null);
							onPick(text, index);
						}}
						onContextMenu={
							touch && onSend
								? (event: MouseEvent) => {
										event.preventDefault();
										setArmed(index);
									}
								: undefined
						}
						onFocus={() => setActive(index)}
						onMouseDown={touch ? event => event.preventDefault() : undefined}
						onKeyDown={event => onKeyDown(event, index)}
						ref={element => {
							buttons.current[index] = element;
						}}
						tabIndex={index === current ? 0 : -1}
						title={touch ? undefined : text}
						type="button"
					>
						<span className="omp-next-chip-text">{text}</span>
						{!touch && <Kbd shortcut={`⌥${index + 1}`} />}
					</button>
					{touch && onSend && armed === index && (
						// controls-ok: the omp-next-chip class draws the whole control
						<button
							className="omp-next-chip omp-next-chip-send"
							data-next-chip-send
							onClick={() => {
								setArmed(null);
								onSend(text);
							}}
							type="button"
						>
							<span className="omp-next-chip-text">{t("input.chips.sendNow")}</span>
						</button>
					)}
				</Fragment>
			))}
		</div>
	);
}
