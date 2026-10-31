/**
 * Chromium draws `:focus-visible` on an element a pointer focused as soon as the document has seen a keydown without
 * Ctrl, Alt or Meta held (blink's `KeyboardEventManager::KeyEvent` → `Node::UpdateHadKeyboardEvent`), and a lone Shift
 * keydown is one: clicking the transcript, a sidebar row or a button and then pressing Shift would ring it.
 *
 * The root carries `data-focus-modality="pointer"` while the last input was a pointer press (a modifier pressed alone,
 * Shift, Caps Lock, …, never counts as moving by keyboard) and the focus is not in a text field, which shows its focus
 * under any input. While it is set no focus style applies: `styles/global.css` drops every outline, and its
 * `focus-visible` variant and the stylesheets' other `:focus-visible` rules exclude `html[data-focus-modality="pointer"]
 * *`. Any other key clears it and Chromium's own `:focus-visible` decides again: Tab and the arrow keys ring what they
 * reach.
 */

/** `KeyboardEvent.key` values of keys that only modify or lock others; pressed alone they never mean keyboard use. */
const MODIFIER_KEYS: Record<string, true> = {
	Alt: true,
	AltGraph: true,
	CapsLock: true,
	Control: true,
	Fn: true,
	FnLock: true,
	Hyper: true,
	Meta: true,
	NumLock: true,
	OS: true,
	ScrollLock: true,
	Shift: true,
	Super: true,
	Symbol: true,
	SymbolLock: true,
};

/** `<input>` types Chromium treats as text fields (`MayTriggerVirtualKeyboard`): focused, they always match `:focus-visible`. */
const TEXT_INPUT_TYPES: Record<string, true> = {
	email: true,
	number: true,
	password: true,
	search: true,
	tel: true,
	text: true,
	url: true,
};

function isTextField(element: Element | null): boolean {
	if (!element) return false;
	if (element.localName === "textarea") return true;
	// `HTMLInputElement.type` is the normalized type: lower case, `text` for a missing or unknown one.
	if (element.localName === "input") return "type" in element && Object.hasOwn(TEXT_INPUT_TYPES, String(element.type));
	return "isContentEditable" in element && element.isContentEditable === true;
}

/** Track pointer versus keyboard focus on `view`'s root element. Returns the uninstall. */
export function installFocusModality(view: Window = window): () => void {
	const doc = view.document;
	const root = doc.documentElement;
	let pointer = false;
	const sync = () => {
		if (pointer && !isTextField(doc.activeElement)) {
			if (root.dataset.focusModality !== "pointer") root.dataset.focusModality = "pointer";
		} else if (root.dataset.focusModality !== undefined) delete root.dataset.focusModality;
	};
	const onPointerDown = () => {
		pointer = true;
		sync();
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (Object.hasOwn(MODIFIER_KEYS, event.key)) return;
		pointer = false;
		sync();
	};
	// Capture on the window: an app handler that stops a keydown or pointerdown still leaves the modality right.
	const capture = { capture: true };
	view.addEventListener("pointerdown", onPointerDown, capture);
	view.addEventListener("keydown", onKeyDown, capture);
	view.addEventListener("focusin", sync, capture);
	return () => {
		view.removeEventListener("pointerdown", onPointerDown, capture);
		view.removeEventListener("keydown", onKeyDown, capture);
		view.removeEventListener("focusin", sync, capture);
		delete root.dataset.focusModality;
	};
}
