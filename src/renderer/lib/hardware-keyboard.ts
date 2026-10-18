/**
 * Whether a physical keyboard is attached to a touch device. A phone or tablet soft keyboard makes plain keys, Backspace
 * and Enter and nothing else: no Esc, Tab, arrows, function keys or chords with ⌘ ⌃ ⌥, and no Shift+Enter. The first such
 * key event is the evidence (a letter or Enter is not: some soft keyboards report a `code` for them), and it holds for
 * the page's life. Until then Enter on a touch device is a newline (`composerEnterNewline`).
 */

const MODIFIERS: Record<string, true> = {
	Shift: true,
	Control: true,
	Alt: true,
	Meta: true,
	CapsLock: true,
	AltGraph: true,
	Fn: true,
	Unidentified: true,
	Process: true,
	Dead: true,
};
const NAVIGATION = /^(Escape|Tab|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert|Delete|F\d{1,2})$/;

let seen = false;

export interface HardwareKeyEvent {
	key: string;
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
}

/** True when `event` is a key only a physical keyboard makes. */
export function isHardwareKey(event: HardwareKeyEvent): boolean {
	if (MODIFIERS[event.key]) return false;
	if (NAVIGATION.test(event.key)) return true;
	// Chords with ⌘ ⌃ ⌥, and Shift with a named key (Shift+Enter, Shift+Backspace): no soft keyboard makes them.
	return event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && event.key.length > 1);
}

/** Record a keydown: the first physical-keyboard key latches. */
export function noteHardwareKey(event: HardwareKeyEvent): void {
	if (!seen && isHardwareKey(event)) seen = true;
}

export function hasHardwareKeyboard(): boolean {
	return seen;
}

export function resetHardwareKeyboardForTests(): void {
	seen = false;
}

/**
 * Whether plain Enter adds a line instead of sending: a touch input without a physical keyboard, unless the
 * "Enter sends on mobile" setting is on. The Send button sends whichever way this answers.
 */
export function composerEnterNewline(touch: boolean, enterSends: boolean): boolean {
	return touch && !enterSends && !seen;
}
