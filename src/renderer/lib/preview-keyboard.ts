/**
 * The phone's keyboard for the streamed preview page. A hidden input on the phone takes focus (the soft keyboard
 * opens, a hardware keyboard types into it); what it reports becomes what the page on the host receives:
 *
 *   - a special key or a shortcut (Enter, Backspace, arrows, Ctrl+A…) → a `key` press, forwarded as keys;
 *   - committed text (a letter from the soft keyboard, a paste, an IME's result) → `text`, inserted at the caret
 *     with `webContents.insertText`, never typed key by key;
 *   - an IME composition (Korean, Japanese, Chinese…) stays on the phone, shown in an overlay, until the
 *     composition is committed: the half-formed syllables are never sent.
 *
 * Soft keyboards report most typing through `beforeinput`, not `keydown` (their `keydown` is often key 229), so
 * `keyInputs` leaves printable keys alone and `beforeInputInputs` takes them.
 */
import type { PreviewStreamInput } from "../../shared/preview";

type Mod = "shift" | "control" | "alt" | "meta";

export interface KeyDownLike {
	key: string;
	keyCode?: number;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	isComposing: boolean;
}

export interface BeforeInputLike {
	inputType: string;
	data: string | null;
	isComposing: boolean;
	/** A paste's text when `data` is null (`dataTransfer.getData("text/plain")`). */
	pasted?: string | null;
}

/** Keys that only change a modifier or mean nothing alone. */
const SILENT_KEYS = new Set([
	"Shift",
	"Control",
	"Alt",
	"Meta",
	"CapsLock",
	"NumLock",
	"ScrollLock",
	"Fn",
	"Dead",
	"Unidentified",
	"Process",
	"Compose",
]);

function mods(event: KeyDownLike): Mod[] {
	const held: Mod[] = [];
	if (event.shiftKey) held.push("shift");
	if (event.ctrlKey) held.push("control");
	if (event.altKey) held.push("alt");
	if (event.metaKey) held.push("meta");
	return held;
}

/**
 * What a `keydown` on the hidden input forwards, or null when the browser should go on (a printable key whose text
 * arrives with `beforeinput`, a composition key, a paste shortcut whose text arrives as a paste). A non-null answer
 * is handled: the caller prevents the default.
 */
export function keyInputs(event: KeyDownLike): PreviewStreamInput[] | null {
	if (event.isComposing || event.keyCode === 229) return null;
	if (SILENT_KEYS.has(event.key)) return null;
	const shortcut = event.ctrlKey || event.metaKey;
	const held = mods(event);
	const modifiers = held.length > 0 ? { mods: held } : {};
	if (event.key.length > 1) return [{ t: "key", key: event.key, ...modifiers }];
	if (shortcut) {
		// Pasting arrives as `beforeinput` with the clipboard's text.
		if (event.key.toLowerCase() === "v") return null;
		return [{ t: "key", key: event.key.toLowerCase(), ...modifiers }];
	}
	return null;
}

export interface BeforeInputResult {
	inputs: PreviewStreamInput[];
	/** The input is handled here: prevent the default so the field stays empty. */
	prevent: boolean;
}

/** What a `beforeinput` on the hidden input forwards. A composition is left alone until `compositionend`. */
export function beforeInputInputs(event: BeforeInputLike): BeforeInputResult {
	if (event.isComposing || event.inputType === "insertCompositionText") return { inputs: [], prevent: false };
	const text = event.data ?? event.pasted ?? null;
	switch (event.inputType) {
		case "insertText":
		case "insertFromPaste":
		case "insertFromYank":
		case "insertReplacementText":
		case "insertFromDrop":
			return { inputs: text ? [{ t: "text", text }] : [], prevent: true };
		case "insertLineBreak":
		case "insertParagraph":
			return { inputs: [{ t: "key", key: "Enter" }], prevent: true };
		case "deleteContentBackward":
		case "deleteWordBackward":
		case "deleteSoftLineBackward":
		case "deleteHardLineBackward":
			return { inputs: [{ t: "key", key: "Backspace" }], prevent: true };
		case "deleteContentForward":
		case "deleteWordForward":
			return { inputs: [{ t: "key", key: "Delete" }], prevent: true };
		default:
			return { inputs: [], prevent: true };
	}
}

/** The committed result of an IME composition (`compositionend`'s data). */
export function compositionInputs(data: string): PreviewStreamInput[] {
	return data ? [{ t: "text", text: data }] : [];
}
