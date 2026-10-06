import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { KEYMAP_ACTIONS, RESERVED_CHORDS } from "../../lib/keymap";
import { useUiStore } from "../../stores/ui";
import { KeyboardSection } from "./KeyboardSection";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(query = ""): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<KeyboardSection query={query} />
			</I18nProvider>,
		);
	});
	await flush();
}

/** The chord of every rendered row, in document order (one Kbd chip per alternative). */
function displayedChords(): string[] {
	return [...document.body.querySelectorAll("[data-hotkey-keys]")].map(cell =>
		[...cell.querySelectorAll("kbd")].map(chip => chip.textContent ?? "").join(" / "),
	);
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	document.body.innerHTML = "";
	useUiStore.setState({ keymapOverrides: {} });
});

describe("KeyboardSection", () => {
	it("renders one row for every remappable action and every chord the app owns", async () => {
		// The reference is derived from the keymap tables. A row missing here is an
		// action nobody can discover or remap, and a duplicated one offers two
		// editors for the same binding.
		await mount();
		const chords = displayedChords();
		for (const action of KEYMAP_ACTIONS) {
			const displayed = action.defaults.join(" / ");
			expect(
				chords.filter(chord => chord === displayed),
				action.id,
			).toHaveLength(1);
		}
		for (const entry of RESERVED_CHORDS) {
			expect(
				chords.filter(chord => chord === entry.chord),
				entry.id,
			).toHaveLength(1);
		}
	});

	it("shows a user override instead of the default it replaced", async () => {
		// A remapped action's old chord is dead; listing both tells the user a key
		// works that no longer does.
		useUiStore.setState({ keymapOverrides: { retry: ["⌥⇧R"] } });
		await mount();
		const chords = displayedChords();
		expect(chords).toContain("⌥⇧R");
		expect(chords).not.toContain("⌥R");
	});

	it("filters rows by the page search query and keeps every row for an empty one", async () => {
		await mount();
		const all = displayedChords().length;
		await act(async () => root.unmount());
		container.remove();

		await mount("⇧Enter");
		expect(displayedChords()).toEqual(["⇧Enter"]);
		expect(all).toBeGreaterThan(1);
	});

	it("keeps rebind controls in the layout so keyboard focus can reach them", async () => {
		// Hover-revealed controls hide with opacity, never display:none — a hidden
		// button is skipped by Tab and its row can never be remapped by keyboard.
		await mount();
		const rebind = [...document.body.querySelectorAll("button")].filter(
			button => button.getAttribute("aria-label") === "Change shortcut",
		);
		expect(rebind).toHaveLength(KEYMAP_ACTIONS.length);
		for (const button of rebind) {
			expect(button.className).not.toMatch(/(^|\s)hidden(\s|$)/);
			expect(button.className).toContain("group-focus-within:opacity-100");
		}
	});
});
