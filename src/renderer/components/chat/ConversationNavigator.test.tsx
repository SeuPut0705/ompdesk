import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { ConversationNavigator, TURN_RAIL_LIMIT } from "./ConversationNavigator";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

// linkedom has no focus model: record what `focus()` reached.
let focused: HTMLElement | null = null;
Object.defineProperty(HTMLElement.prototype, "focus", {
	configurable: true,
	value(this: HTMLElement) {
		focused = this;
	},
});

let container: HTMLElement;
let root: Root;

const ANCHORS = [
	{ key: "one", rowIndex: 3, preview: "First question", timestamp: 100 },
	{ key: "two", rowIndex: 9, preview: "Second question", timestamp: 200 },
	{ key: "three", rowIndex: 14, preview: "Third question", timestamp: 300 },
];

function turns(count: number): typeof ANCHORS {
	return Array.from({ length: count }, (_, index) => ({
		key: `turn-${index}`,
		rowIndex: index * 3,
		preview: `Question ${index + 1}`,
		timestamp: 1000 + index,
	}));
}

function rail(anchors: typeof ANCHORS, activeIndex: number, onNavigate: (rowIndex: number) => void) {
	return (
		<I18nProvider>
			<ConversationNavigator activeIndex={activeIndex} anchors={anchors} onNavigate={onNavigate} />
		</I18nProvider>
	);
}

async function mount(onNavigate: (rowIndex: number) => void, anchors = ANCHORS, activeIndex = 1): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(rail(anchors, activeIndex, onNavigate));
	});
}

async function showTurn(anchors: typeof ANCHORS, activeIndex: number): Promise<void> {
	await act(async () => {
		root.render(rail(anchors, activeIndex, () => {}));
	});
}

const markers = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".omp-conversation-nav-marker"));
const earlier = () => container.querySelector<HTMLButtonElement>(".omp-conversation-nav-earlier");
const press = (button: HTMLButtonElement | null | undefined, detail = 1) =>
	act(async () => {
		button?.dispatchEvent(Object.assign(new Event("click", { bubbles: true, cancelable: true }), { detail }));
	});
/** The turn numbers the ticks name, first and last ("Jump to turn 231 of 250: …"). */
const drawn = () => {
	const numbers = markers().map(button => Number(/turn (\d+) of/.exec(button.getAttribute("aria-label") ?? "")?.[1]));
	return [numbers[0], numbers.at(-1)];
};

afterEach(async () => {
	if (root) await act(async () => root.unmount());
	container?.remove();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("ConversationNavigator", () => {
	it("marks the current turn and jumps to the selected virtual row", async () => {
		const onNavigate = vi.fn();
		await mount(onNavigate);
		const buttons = Array.from(container.querySelectorAll("button"));

		expect(buttons).toHaveLength(3);
		expect(container.querySelector(".omp-conversation-nav-stack")).not.toBeNull();
		expect(buttons.every(button => !button.hasAttribute("style"))).toBe(true);
		expect(buttons[1]?.getAttribute("aria-current")).toBe("location");
		await act(async () => buttons[2]?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
		expect(onNavigate).toHaveBeenCalledWith(14);
	});

	it("shows the user-message preview on hover", async () => {
		await mount(() => {});
		const first = container.querySelector("button");
		await act(async () => first?.dispatchEvent(new Event("mouseover", { bubbles: true })));

		expect(container.querySelector("[role='tooltip']")?.textContent ?? "").toContain("First question");
	});

	it("stays out of the gutter until the conversation has three user turns", async () => {
		await mount(() => {}, ANCHORS.slice(0, 2));
		expect(container.querySelector(".omp-conversation-nav")).toBeNull();
		expect(container.querySelectorAll("button")).toHaveLength(0);
	});

	it("draws the newest 20 turns of a long session and an item for the rest", async () => {
		const anchors = turns(250);
		await mount(() => {}, anchors, 249);

		expect(TURN_RAIL_LIMIT).toBe(20);
		expect(markers()).toHaveLength(TURN_RAIL_LIMIT);
		expect(drawn()).toEqual([231, 250]);
		expect(markers().at(-1)?.getAttribute("aria-current")).toBe("location");
		expect(earlier()?.getAttribute("aria-label")).toBe("230 earlier");
		expect(earlier()?.textContent).toContain("230");
	});

	it("moves the window one page up per press of the earlier item, until none is left", async () => {
		const onNavigate = vi.fn();
		await mount(onNavigate, turns(45), 44);
		expect(drawn()).toEqual([26, 45]);
		expect(earlier()?.getAttribute("aria-label")).toBe("25 earlier");

		await press(earlier());
		expect(drawn()).toEqual([6, 25]);
		expect(earlier()?.getAttribute("aria-label")).toBe("5 earlier");
		expect(markers().every(button => button.getAttribute("aria-current") === null)).toBe(true);
		expect(onNavigate).not.toHaveBeenCalled();

		await press(earlier());
		expect(drawn()).toEqual([1, 20]);
		expect(earlier()).toBeNull();
	});

	it("keeps the window a reader paged to until the turn in view changes", async () => {
		const anchors = turns(100);
		await mount(() => {}, anchors, 99);
		await press(earlier());
		expect(drawn()).toEqual([61, 80]);

		await showTurn(anchors, 99);
		expect(drawn()).toEqual([61, 80]);
	});

	it("moves the window when the turn in view scrolls above it, and back when it returns", async () => {
		const anchors = turns(250);
		await mount(() => {}, anchors, 249);

		await showTurn(anchors, 100);
		expect(drawn()).toEqual([101, 120]);
		expect(markers()[0]?.getAttribute("aria-current")).toBe("location");
		expect(earlier()?.getAttribute("aria-label")).toBe("100 earlier");

		await showTurn(anchors, 105);
		expect(drawn()).toEqual([101, 120]);
		expect(markers()[5]?.getAttribute("aria-current")).toBe("location");

		await showTurn(anchors, 125);
		expect(drawn()).toEqual([107, 126]);
		expect(markers().at(-1)?.getAttribute("aria-current")).toBe("location");

		await showTurn(anchors, 249);
		expect(drawn()).toEqual([231, 250]);
	});

	it("follows the newest turns as they arrive", async () => {
		await mount(() => {}, turns(30), 29);
		expect(drawn()).toEqual([11, 30]);
		await showTurn(turns(31), 30);
		expect(drawn()).toEqual([12, 31]);
	});

	it("keeps its one tab stop inside the window", async () => {
		const anchors = turns(100);
		await mount(() => {}, anchors, 99);
		await press(earlier());
		expect(markers().filter(button => button.getAttribute("tabindex") === "0")).toHaveLength(1);
	});

	it("draws every turn, with no earlier item, up to 20 turns", async () => {
		await mount(() => {}, turns(TURN_RAIL_LIMIT), 5);
		expect(drawn()).toEqual([1, 20]);
		expect(earlier()).toBeNull();
		expect(markers()[5]?.getAttribute("aria-current")).toBe("location");
	});

	it("gives the keyboard's focus to the first tick when the earlier item pages out of existence", async () => {
		await mount(() => {}, turns(30), 29);
		await press(earlier(), 0);
		expect(earlier()).toBeNull();
		expect(focused).toBe(markers()[0]);
	});

	it("reaches the earlier item with the arrow keys from the first tick", async () => {
		await mount(() => {}, turns(100), 99);
		await act(async () => {
			markers()[0]?.dispatchEvent(
				Object.assign(new Event("keydown", { bubbles: true, cancelable: true }), { key: "ArrowUp" }),
			);
		});
		expect(focused).toBe(earlier());
	});
});
