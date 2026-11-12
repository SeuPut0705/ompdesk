/**
 * `webContents.sendInputEvent` over the DevTools protocol: Electron's mouse, wheel and keyboard input events as the
 * `Input.dispatch*` commands that reach the page through the browser process the same way.
 */
export interface MouseInput {
	type: "mouseDown" | "mouseUp" | "mouseMove" | "mouseEnter" | "mouseLeave" | "contextMenu";
	x: number;
	y: number;
	button?: "left" | "middle" | "right";
	clickCount?: number;
	modifiers?: string[];
}

export interface WheelInput {
	type: "mouseWheel";
	x: number;
	y: number;
	deltaX?: number;
	deltaY?: number;
	modifiers?: string[];
}

export interface KeyInput {
	type: "rawKeyDown" | "keyDown" | "keyUp" | "char";
	keyCode: string;
	modifiers?: string[];
}

export type InputEvent = MouseInput | WheelInput | KeyInput;

export interface CdpCommand {
	method: string;
	params: Record<string, unknown>;
}

const MODIFIER_BITS: Readonly<Record<string, number>> = {
	alt: 1,
	control: 2,
	ctrl: 2,
	meta: 4,
	command: 4,
	cmd: 4,
	shift: 8,
};
const BUTTON_BITS: Readonly<Record<string, number>> = { left: 1, right: 2, middle: 4 };

function modifierBits(modifiers: readonly string[] | undefined): number {
	let bits = 0;
	for (const modifier of modifiers ?? []) bits |= MODIFIER_BITS[modifier.toLowerCase()] ?? 0;
	return bits;
}

function heldButtons(modifiers: readonly string[] | undefined): number {
	let bits = 0;
	for (const modifier of modifiers ?? []) {
		if (modifier === "leftbuttondown") bits |= BUTTON_BITS.left;
		else if (modifier === "rightbuttondown") bits |= BUTTON_BITS.right;
		else if (modifier === "middlebuttondown") bits |= BUTTON_BITS.middle;
	}
	return bits;
}

interface KeyInfo {
	key: string;
	code: string;
	vk: number;
}

const NAMED: Readonly<Record<string, KeyInfo>> = {
	Left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
	Right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
	Up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
	Down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
	Enter: { key: "Enter", code: "Enter", vk: 13 },
	Return: { key: "Enter", code: "Enter", vk: 13 },
	Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
	Delete: { key: "Delete", code: "Delete", vk: 46 },
	Tab: { key: "Tab", code: "Tab", vk: 9 },
	Escape: { key: "Escape", code: "Escape", vk: 27 },
	Esc: { key: "Escape", code: "Escape", vk: 27 },
	Home: { key: "Home", code: "Home", vk: 36 },
	End: { key: "End", code: "End", vk: 35 },
	PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
	PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
	Insert: { key: "Insert", code: "Insert", vk: 45 },
	Space: { key: " ", code: "Space", vk: 32 },
};

/** Punctuation keys of a US layout: the character → its DOM `code` and virtual-key code. */
const PUNCTUATION: Readonly<Record<string, { code: string; vk: number }>> = {
	";": { code: "Semicolon", vk: 186 },
	"=": { code: "Equal", vk: 187 },
	",": { code: "Comma", vk: 188 },
	"-": { code: "Minus", vk: 189 },
	".": { code: "Period", vk: 190 },
	"/": { code: "Slash", vk: 191 },
	"`": { code: "Backquote", vk: 192 },
	"[": { code: "BracketLeft", vk: 219 },
	"\\": { code: "Backslash", vk: 220 },
	"]": { code: "BracketRight", vk: 221 },
	"'": { code: "Quote", vk: 222 },
};

function keyInfo(keyCode: string): KeyInfo {
	const named = NAMED[keyCode];
	if (named) return named;
	const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(keyCode);
	if (fn) return { key: keyCode, code: keyCode, vk: 111 + Number(fn[1]) };
	if (/^[a-z]$/i.test(keyCode))
		return { key: keyCode, code: `Key${keyCode.toUpperCase()}`, vk: keyCode.toUpperCase().charCodeAt(0) };
	if (/^[0-9]$/.test(keyCode)) return { key: keyCode, code: `Digit${keyCode}`, vk: keyCode.charCodeAt(0) };
	const punctuation = PUNCTUATION[keyCode];
	if (punctuation) return { key: keyCode, ...punctuation };
	return { key: keyCode, code: "", vk: 0 };
}

/** The DevTools commands that deliver `event`. */
export function inputCommands(event: InputEvent): CdpCommand[] {
	if (event.type === "mouseWheel") {
		// Electron's delta has the opposite sign of the protocol's (positive scrolls the content down there).
		return [
			{
				method: "Input.dispatchMouseEvent",
				params: {
					type: "mouseWheel",
					x: event.x,
					y: event.y,
					deltaX: event.deltaX === undefined || event.deltaX === 0 ? 0 : -event.deltaX,
					deltaY: event.deltaY === undefined || event.deltaY === 0 ? 0 : -event.deltaY,
					modifiers: modifierBits(event.modifiers),
				},
			},
		];
	}
	if ("keyCode" in event) {
		const info = keyInfo(event.keyCode);
		const modifiers = modifierBits(event.modifiers);
		if (event.type === "char") {
			const text = event.keyCode === "Enter" ? "\r" : event.keyCode;
			return [
				{
					method: "Input.dispatchKeyEvent",
					params: { type: "char", text, unmodifiedText: text, key: text, modifiers },
				},
			];
		}
		return [
			{
				method: "Input.dispatchKeyEvent",
				params: {
					type: event.type === "keyUp" ? "keyUp" : "rawKeyDown",
					key: info.key,
					code: info.code,
					windowsVirtualKeyCode: info.vk,
					nativeVirtualKeyCode: info.vk,
					modifiers,
				},
			},
		];
	}
	if ("keyCode" in event) return [];
	const button = event.button ?? "left";
	const base = {
		x: event.x,
		y: event.y,
		modifiers: modifierBits(event.modifiers),
		button: "none" as string,
		buttons: heldButtons(event.modifiers),
	};
	switch (event.type) {
		case "mouseDown":
			return [
				{
					method: "Input.dispatchMouseEvent",
					params: {
						...base,
						type: "mousePressed",
						button,
						buttons: BUTTON_BITS[button] ?? 1,
						clickCount: event.clickCount ?? 1,
					},
				},
			];
		case "mouseUp":
			return [
				{
					method: "Input.dispatchMouseEvent",
					params: { ...base, type: "mouseReleased", button, buttons: 0, clickCount: event.clickCount ?? 1 },
				},
			];
		case "contextMenu":
			return [
				{
					method: "Input.dispatchMouseEvent",
					params: { ...base, type: "mousePressed", button: "right", buttons: 2, clickCount: 1 },
				},
				{
					method: "Input.dispatchMouseEvent",
					params: { ...base, type: "mouseReleased", button: "right", buttons: 0, clickCount: 1 },
				},
			];
		default:
			return [
				{
					method: "Input.dispatchMouseEvent",
					params: { ...base, type: "mouseMoved", ...(base.buttons === 0 ? {} : { button: "left" }) },
				},
			];
	}
}
