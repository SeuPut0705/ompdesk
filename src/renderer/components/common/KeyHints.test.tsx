/** KeyHints: each hint is its keys and its word; under a finger the keys go and only the row's action stays. */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { TOUCH_QUERY } from "../../hooks/shell-queries";
import { resetShellModeForTests } from "../../hooks/use-shell-mode";
import { KeyHints } from "./KeyHints";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

const HINTS = [
	{ keys: ["↑", "↓"], label: "move" },
	{ keys: ["↵"], label: "open" },
];

async function mount(node: React.ReactNode): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () => root?.render(node));
	return host as unknown as HTMLElement;
}

it("draws each hint as its keys and its word, in order, with the row's action at the end", async () => {
	const host = await mount(
		<KeyHints data-picker-hints hints={HINTS}>
			<button type="button">Manage providers</button>
		</KeyHints>,
	);
	// The keys' spelling follows the platform (formatShortcut); the count and the word do not.
	const hints = [...host.querySelectorAll("[data-key-hint]")].map(hint => ({
		keys: hint.querySelectorAll("kbd").length,
		word: hint.lastChild?.textContent,
	}));
	expect(hints).toEqual([
		{ keys: 2, word: "move" },
		{ keys: 1, word: "open" },
	]);
	expect(host.querySelector("[data-picker-hints] button")?.textContent).toBe("Manage providers");
});

it("leaves the keys out on a touch screen, keeping only the row's action", async () => {
	document.documentElement.dataset.platform = "web";
	Object.assign(window, {
		matchMedia: (query: string) => ({
			matches: query === TOUCH_QUERY,
			addEventListener: () => {},
			removeEventListener: () => {},
		}),
	});
	resetShellModeForTests();
	try {
		const host = await mount(
			<>
				<KeyHints hints={HINTS} />
				<KeyHints hints={HINTS}>
					<button type="button">Manage providers</button>
				</KeyHints>
			</>,
		);
		expect(host.querySelectorAll("kbd")).toHaveLength(0);
		expect(host.textContent).toBe("Manage providers");
	} finally {
		Reflect.deleteProperty(window, "matchMedia");
		Reflect.deleteProperty(document.documentElement.dataset, "platform");
		resetShellModeForTests();
	}
});
