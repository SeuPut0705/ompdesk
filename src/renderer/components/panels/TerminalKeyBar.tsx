import { useCallback, useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";
import {
	FONT_SCALE_MAX,
	FONT_SCALE_MIN,
	type HeldModifiers,
	TERMINAL_KEYS,
	type TerminalKey,
} from "../../lib/terminal-keys";
import { Button } from "../common";

/** How long an arrow is held before it repeats, and the gap between repeats. */
const REPEAT_DELAY_MS = 400;
const REPEAT_MS = 100;

/** A held modifier reads as pressed beside its neighbours. */
const KEY = "min-w-(--sc-control-md) aria-pressed:bg-(--sc-selected)";

/**
 * The keys a soft keyboard lacks, above it (design §7.2): text size on the left, then a row that scrolls sideways.
 * A key goes out on pointer down (no wait for the click) and never takes focus from the terminal, so the soft
 * keyboard stays up; a held arrow repeats. Ctrl and Alt are sticky toggles the panel applies to the next key.
 */
export function TerminalKeyBar({
	held,
	fontScale,
	disabled,
	onModifier,
	onKey,
	onFontScale,
}: {
	held: HeldModifiers;
	fontScale: number;
	disabled: boolean;
	onModifier: (modifier: "ctrl" | "alt") => void;
	onKey: (key: TerminalKey) => void;
	/** `smaller` / `larger` step the scale; `reset` returns to 100 %. */
	onFontScale: (change: "smaller" | "larger" | "reset") => void;
}) {
	const t = useT();
	const repeating = useRef<{ delay?: number; interval?: number }>({});
	const stop = useCallback(() => {
		window.clearTimeout(repeating.current.delay);
		window.clearInterval(repeating.current.interval);
		repeating.current = {};
	}, []);
	useEffect(() => stop, [stop]);
	const press = (key: TerminalKey) => {
		if (key.modifier) {
			onModifier(key.modifier);
			return;
		}
		onKey(key);
		if (!key.repeat) return;
		stop();
		repeating.current.delay = window.setTimeout(() => {
			repeating.current.interval = window.setInterval(() => onKey(key), REPEAT_MS);
		}, REPEAT_DELAY_MS);
	};
	return (
		<div
			className="flex min-w-0 shrink-0 items-center gap-1 border-t border-(--sc-divider) bg-(--sc-surface-1) px-2"
			role="toolbar"
			aria-label={t("panel.terminal.keys")}
			data-terminal-keybar
		>
			<div className="flex shrink-0 items-center gap-1">
				<Button
					aria-label={t("panel.terminal.fontSmaller")}
					className={KEY}
					variant="secondary"
					data-terminal-font="smaller"
					disabled={fontScale <= FONT_SCALE_MIN}
					onClick={() => onFontScale("smaller")}
				>
					A−
				</Button>
				<Button
					aria-label={t("panel.terminal.fontScale", { percent: fontScale })}
					className={`${KEY} tabular-nums`}
					variant="secondary"
					data-terminal-font="reset"
					onClick={() => onFontScale("reset")}
				>
					{fontScale}%
				</Button>
				<Button
					aria-label={t("panel.terminal.fontLarger")}
					className={KEY}
					variant="secondary"
					data-terminal-font="larger"
					disabled={fontScale >= FONT_SCALE_MAX}
					onClick={() => onFontScale("larger")}
				>
					A+
				</Button>
			</div>
			{/* The scroller clips its keys' hit areas to its own box: it takes the bar's padding, so a key's reach fills the bar. */}
			<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none]">
				{TERMINAL_KEYS.map(key => (
					<Button
						aria-label={key.aria ? t(key.aria) : undefined}
						aria-pressed={key.modifier ? held[key.modifier] : undefined}
						className={KEY}
						variant="secondary"
						data-terminal-key={key.id}
						disabled={disabled}
						key={key.id}
						onClick={event => {
							// A pointer press already sent the key; a click with no pointer (the keyboard) sends it here.
							if (event.detail === 0) press(key);
						}}
						onKeyUp={stop}
						onMouseDown={event => event.preventDefault()}
						onPointerCancel={stop}
						onPointerDown={event => {
							event.preventDefault();
							press(key);
						}}
						onPointerLeave={stop}
						onPointerUp={stop}
					>
						{key.label}
					</Button>
				))}
			</div>
		</div>
	);
}
