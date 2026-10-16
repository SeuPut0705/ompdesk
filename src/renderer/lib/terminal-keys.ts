/**
 * The phone's key bar for the Terminal (design §7.2): the keys a soft keyboard lacks (Esc, Tab, Ctrl, arrows, the
 * punctuation a shell needs) as the byte sequences a PTY expects. Ctrl and Alt are sticky: tapped once they
 * modify the next key, from the bar or from the soft keyboard, and then let go.
 */

export interface TerminalKey {
	id: string;
	/** What the button shows. */
	label: string;
	/** i18n key of its accessible name, when the label alone is not one (an arrow, a symbol). */
	aria?: string;
	/** What it sends; absent for the modifiers. */
	data?: string;
	/** A modifier that stays on for the next key. */
	modifier?: "ctrl" | "alt";
	/** Held down it repeats (the arrows). */
	repeat?: boolean;
}

const ESC = "\x1b";

/** The bar, left to right; it scrolls sideways on a narrow phone. */
export const TERMINAL_KEYS: readonly TerminalKey[] = [
	{ id: "esc", label: "Esc", data: ESC },
	{ id: "tab", label: "Tab", data: "\t" },
	{ id: "ctrl", label: "Ctrl", modifier: "ctrl" },
	{ id: "alt", label: "Alt", modifier: "alt" },
	{ id: "left", label: "←", aria: "panel.terminal.key.left", data: `${ESC}[D`, repeat: true },
	{ id: "down", label: "↓", aria: "panel.terminal.key.down", data: `${ESC}[B`, repeat: true },
	{ id: "up", label: "↑", aria: "panel.terminal.key.up", data: `${ESC}[A`, repeat: true },
	{ id: "right", label: "→", aria: "panel.terminal.key.right", data: `${ESC}[C`, repeat: true },
	{ id: "pipe", label: "|", aria: "panel.terminal.key.pipe", data: "|" },
	{ id: "tilde", label: "~", aria: "panel.terminal.key.tilde", data: "~" },
	{ id: "slash", label: "/", aria: "panel.terminal.key.slash", data: "/" },
	{ id: "dash", label: "-", aria: "panel.terminal.key.dash", data: "-" },
	{ id: "backslash", label: "\\", aria: "panel.terminal.key.backslash", data: "\\" },
	{ id: "underscore", label: "_", aria: "panel.terminal.key.underscore", data: "_" },
	{ id: "home", label: "Home", data: `${ESC}[H` },
	{ id: "end", label: "End", data: `${ESC}[F` },
	{ id: "pgup", label: "PgUp", data: `${ESC}[5~` },
	{ id: "pgdn", label: "PgDn", data: `${ESC}[6~` },
	{ id: "ctrl-c", label: "^C", aria: "panel.terminal.key.ctrlC", data: "\x03" },
	{ id: "ctrl-d", label: "^D", aria: "panel.terminal.key.ctrlD", data: "\x04" },
	{ id: "shift-tab", label: "⇧Tab", aria: "panel.terminal.key.shiftTab", data: `${ESC}[Z` },
	{ id: "colon", label: ":", data: ":" },
	{ id: "semicolon", label: ";", data: ";" },
	{ id: "quote", label: '"', data: '"' },
	{ id: "apostrophe", label: "'", data: "'" },
	{ id: "lt", label: "<", data: "<" },
	{ id: "gt", label: ">", data: ">" },
	{ id: "lbrace", label: "{", data: "{" },
	{ id: "rbrace", label: "}", data: "}" },
	{ id: "lbracket", label: "[", data: "[" },
	{ id: "rbracket", label: "]", data: "]" },
	{ id: "lparen", label: "(", data: "(" },
	{ id: "rparen", label: ")", data: ")" },
	{ id: "dollar", label: "$", data: "$" },
	{ id: "amp", label: "&", data: "&" },
	{ id: "star", label: "*", data: "*" },
	{ id: "caret", label: "^", data: "^" },
];

/** Modifier keys held for the next key. */
export interface HeldModifiers {
	ctrl: boolean;
	alt: boolean;
}

/** The control character `char` makes with Ctrl held (`Ctrl+C` = 0x03), or null for a key with none. */
export function controlCharacter(char: string): string | null {
	if (char.length !== 1) return null;
	const code = char.toUpperCase().charCodeAt(0);
	if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40);
	if (char === " " || char === "2") return "\x00";
	if (char === "?") return "\x7f";
	return null;
}

/** `ESC [ <final>` with a modifier parameter: Ctrl is 5, Alt 3, both 7 (`ESC [ 1 ; 5 A` is Ctrl+Up). */
function modifiedCsi(data: string, mods: HeldModifiers): string | null {
	const match = /^\x1b\[([A-D]|[HF])$/.exec(data);
	if (!match) return null;
	const parameter = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
	return `${ESC}[1;${parameter}${match[1]}`;
}

/**
 * `data` (a key's bytes, or what the soft keyboard typed) with the held modifiers applied: Ctrl turns a letter
 * into its control character and modifies an arrow, Alt prefixes Esc. Data a modifier cannot change goes through
 * unchanged. A multi-character paste is never modified.
 */
export function applyModifiers(data: string, mods: HeldModifiers): string {
	if (!mods.ctrl && !mods.alt) return data;
	const csi = modifiedCsi(data, mods);
	if (csi) return csi;
	if ([...data].length !== 1) return data;
	let out = data;
	if (mods.ctrl) out = controlCharacter(data) ?? data;
	return mods.alt ? `${ESC}${out}` : out;
}

/** Whether `data` is a single key (so a sticky modifier is spent on it) rather than a paste or a sequence. */
export function isSingleKey(data: string): boolean {
	return [...data].length === 1 || /^\x1b\[[A-D HF]$/.test(data) || /^\x1b\[[56]~$/.test(data);
}

/** The terminal's font scale, a percentage of the base size: 50 to 200, in steps of 10. */
export const FONT_SCALE_MIN = 50;
export const FONT_SCALE_MAX = 200;
export const FONT_SCALE_STEP = 10;
export const FONT_SCALE_DEFAULT = 100;
export const TERMINAL_BASE_FONT_PX = 12;

export function clampFontScale(percent: number): number {
	if (!Number.isFinite(percent)) return FONT_SCALE_DEFAULT;
	const stepped = Math.round(percent / FONT_SCALE_STEP) * FONT_SCALE_STEP;
	return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, stepped));
}

/** The xterm font size, in px, for a scale. */
export function fontSizeFor(percent: number): number {
	return Math.round((TERMINAL_BASE_FONT_PX * clampFontScale(percent)) / 100);
}
