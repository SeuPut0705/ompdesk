/**
 * Tabs: tablist/tab semantics, roving tabindex, and the ←/→/Home/End keys as implemented (wrap at the ends,
 * disabled tabs skipped). Every key test asserts the exact id reported to onChange.
 */

import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TabItem, Tabs, type TabsVariant } from "./Tabs";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

beforeEach(() => {
	// Focus follows the new tab on the next frame; run it synchronously so the test can observe it.
	vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
		callback();
		return 0;
	});
	vi.stubGlobal("CSS", { escape: (value: string) => value });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const TABS: TabItem[] = [
	{ id: "a", label: "Alpha" },
	{ id: "b", label: "Beta", badge: 3 },
	{ id: "c", label: "Gamma" },
];

async function mount(node: React.ReactNode): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(node));
}

function tabs(): HTMLElement[] {
	return [...document.querySelectorAll("[role='tab']")] as HTMLElement[];
}

async function press(key: string): Promise<void> {
	const list = document.querySelector("[role='tablist']") as HTMLElement;
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "key", { value: key });
	await act(async () => {
		list.dispatchEvent(event);
	});
}

/** Controlled host, like real consumers: the reported id becomes the active one. */
function Host({
	items = TABS,
	initial,
	onChange,
	variant,
}: {
	items?: TabItem[];
	initial: string;
	onChange: (id: string) => void;
	variant?: TabsVariant;
}) {
	const [active, setActive] = useState(initial);
	return (
		<Tabs
			activeId={active}
			ariaLabel="Sections"
			onChange={id => {
				onChange(id);
				setActive(id);
			}}
			tabs={items}
			variant={variant}
		/>
	);
}

function selectedIds(): string[] {
	return tabs()
		.filter(tab => tab.getAttribute("aria-selected") === "true")
		.map(tab => tab.getAttribute("data-tab-id") ?? "");
}

describe("Tabs", () => {
	it("exposes a named tablist of tabs with exactly the active one selected and tabbable", async () => {
		await mount(<Tabs activeId="b" ariaLabel="Sections" onChange={() => {}} tabs={TABS} />);
		const list = document.querySelector("[role='tablist']");
		expect(list?.getAttribute("aria-label")).toBe("Sections");
		expect(tabs().map(tab => tab.textContent)).toEqual(["Alpha", "Beta3", "Gamma"]);
		expect(selectedIds()).toEqual(["b"]);
		expect(tabs().map(tab => tab.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
	});

	it("keeps the same semantics in the segmented variant", async () => {
		await mount(<Tabs activeId="c" onChange={() => {}} tabs={TABS} variant="segmented" />);
		expect(document.querySelectorAll("[role='tablist']")).toHaveLength(1);
		expect(selectedIds()).toEqual(["c"]);
		expect(tabs().map(tab => tab.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
	});

	it("may have no tab selected: the first one is the Tab stop and ←/→ start from the ends", async () => {
		const change = vi.fn();
		await mount(<Host initial="" items={TABS} onChange={change} />);
		expect(selectedIds()).toEqual([]);
		expect(tabs().map(tab => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
		await press("ArrowRight");
		expect(change).toHaveBeenLastCalledWith("a");
	});

	it("reports the clicked tab's id, and that a click moved it", async () => {
		const change = vi.fn();
		await mount(<Tabs activeId="a" onChange={change} tabs={TABS} />);
		await act(async () => tabs()[2].click());
		expect(change).toHaveBeenCalledExactlyOnceWith("c", "click");
	});

	it("says a key moved the selection, so a caller can keep focus on the strip", async () => {
		const change = vi.fn();
		await mount(<Tabs activeId="a" onChange={change} tabs={TABS} />);
		await press("ArrowRight");
		await press("End");
		expect(change.mock.calls).toEqual([
			["b", "key"],
			["c", "key"],
		]);
	});

	it("carries a tab's data hooks and marks, never a native title, and the list's own data hooks", async () => {
		await mount(
			<Tabs
				activeId="q0"
				ariaLabel="Questions"
				data-ask-steps=""
				onChange={() => {}}
				tabs={[
					{
						id: "q0",
						label: "Target",
						tooltip: "Target · Where should this deploy?",
						attrs: { "data-ask-step": 0 },
						leading: <svg aria-hidden data-mark="done" />,
						trailing: <span className="sr-only">, answered</span>,
					},
					{ id: "q1", label: "2", attrs: { "data-ask-step": 1 } },
				]}
				variant="segmented"
			/>,
		);
		const list = document.querySelector("[role='tablist']");
		expect(list?.hasAttribute("data-ask-steps")).toBe(true);
		const [first, second] = tabs();
		expect(first.hasAttribute("title")).toBe(false);
		expect(first.getAttribute("data-ask-step")).toBe("0");
		expect(first.getAttribute("data-tab-id")).toBe("q0");
		// The mark leads the label; the words that complete the name trail it.
		expect(first.firstElementChild?.querySelector("[data-mark='done']")).not.toBeNull();
		expect(first.lastElementChild?.textContent).toBe(", answered");
		expect(first.textContent).toBe("Target, answered");
		expect(second.hasAttribute("title")).toBe(false);
		expect(second.getAttribute("data-ask-step")).toBe("1");
		expect(second.querySelector("[data-mark]")).toBeNull();
	});

	it("shows a tab's tooltip on keyboard focus, and a click still selects the tab", async () => {
		const change = vi.fn();
		// linkedom knows no `:focus-visible`; this focus came from the keyboard.
		const matches = HTMLElement.prototype.matches;
		vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
			return selector === ":focus-visible" || matches.call(this, selector);
		});
		await mount(
			<Tabs
				activeId="a"
				onChange={change}
				tabs={[
					{ id: "a", label: "Alpha" },
					{ id: "b", label: "Beta", tooltip: "Beta · the second step" },
				]}
			/>,
		);
		await act(async () => tabs()[1]?.dispatchEvent(new Event("focusin", { bubbles: true })));
		expect(document.querySelector("[role=tooltip]")?.textContent).toBe("Beta · the second step");
		await act(async () => tabs()[1]?.click());
		expect(change).toHaveBeenCalledWith("b", "click");
	});

	it("does not report a click on a disabled tab", async () => {
		const change = vi.fn();
		await mount(
			<Tabs
				activeId="a"
				onChange={change}
				tabs={[
					{ id: "a", label: "Alpha" },
					{ id: "b", label: "Beta", disabled: true },
				]}
			/>,
		);
		expect((tabs()[1] as HTMLButtonElement).disabled).toBe(true);
		await act(async () => tabs()[1].click());
		expect(change).not.toHaveBeenCalled();
	});

	it("moves to the next tab on ArrowRight and the previous on ArrowLeft", async () => {
		const change = vi.fn();
		await mount(<Host initial="b" onChange={change} />);
		await press("ArrowRight");
		expect(change).toHaveBeenLastCalledWith("c");
		expect(selectedIds()).toEqual(["c"]);
		await press("ArrowLeft");
		await press("ArrowLeft");
		expect(change.mock.calls.map(call => call[0])).toEqual(["c", "b", "a"]);
		expect(selectedIds()).toEqual(["a"]);
		expect(tabs().map(tab => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
	});

	it("wraps around at both ends", async () => {
		const change = vi.fn();
		await mount(<Host initial="c" onChange={change} />);
		await press("ArrowRight");
		expect(change).toHaveBeenLastCalledWith("a");
		await press("ArrowLeft");
		expect(change).toHaveBeenLastCalledWith("c");
	});

	it("jumps to the first tab on Home and the last on End", async () => {
		const change = vi.fn();
		await mount(<Host initial="b" onChange={change} />);
		await press("End");
		expect(change).toHaveBeenLastCalledWith("c");
		await press("Home");
		expect(change).toHaveBeenLastCalledWith("a");
		expect(change).toHaveBeenCalledTimes(2);
	});

	it("skips disabled tabs when moving, wrapping and jumping", async () => {
		const items: TabItem[] = [
			{ id: "a", label: "Alpha" },
			{ id: "b", label: "Beta", disabled: true },
			{ id: "c", label: "Gamma" },
			{ id: "d", label: "Delta", disabled: true },
		];
		const change = vi.fn();
		await mount(<Host initial="a" items={items} onChange={change} />);
		await press("ArrowRight");
		expect(change).toHaveBeenLastCalledWith("c");
		await press("ArrowRight");
		expect(change).toHaveBeenLastCalledWith("a");
		await press("End");
		expect(change).toHaveBeenLastCalledWith("c");
		await press("ArrowLeft");
		expect(change.mock.calls.map(call => call[0])).toEqual(["c", "a", "c", "a"]);
	});

	it("focuses the newly selected tab after a key move", async () => {
		const focused: string[] = [];
		vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
			focused.push(this.getAttribute("data-tab-id") ?? "");
		});
		await mount(<Host initial="a" onChange={() => {}} />);
		await press("ArrowRight");
		await press("End");
		expect(focused).toEqual(["b", "c"]);
	});

	it("ignores other keys without changing the selection", async () => {
		const change = vi.fn();
		await mount(<Host initial="a" onChange={change} />);
		await press("ArrowDown");
		await press("Enter");
		await press("x");
		expect(change).not.toHaveBeenCalled();
		expect(selectedIds()).toEqual(["a"]);
	});

	it("does nothing on arrow keys when every tab is disabled", async () => {
		const change = vi.fn();
		await mount(
			<Host
				initial="a"
				items={[
					{ id: "a", label: "Alpha", disabled: true },
					{ id: "b", label: "Beta", disabled: true },
				]}
				onChange={change}
			/>,
		);
		await press("ArrowRight");
		await press("Home");
		expect(change).not.toHaveBeenCalled();
	});

	it("closes a tab from its ✕ or with Delete on it, and keeps the ✕ out of the tab list's reading and Tab order", async () => {
		function Closable() {
			const [open, setOpen] = useState(["a", "b", "c"]);
			const [active, setActive] = useState("b");
			const close = (id: string) => {
				const rest = open.filter(item => item !== id);
				setOpen(rest);
				if (id === active) setActive(rest[0] ?? "");
			};
			return (
				<Tabs
					activeId={active}
					ariaLabel="Files"
					onChange={setActive}
					tabs={open.map(id => ({
						id,
						label: id.toUpperCase(),
						onClose: () => close(id),
						closeLabel: `Close ${id}`,
					}))}
					variant="pills"
				/>
			);
		}
		const focused: string[] = [];
		vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
			focused.push(this.getAttribute("data-tab-id") ?? "");
		});
		await mount(<Closable />);
		expect(document.querySelector("[role='tablist']")?.querySelectorAll("[role='tab']")).toHaveLength(3);
		const pointerClose = document.querySelector("[aria-label='Close a']") as HTMLElement;
		expect(pointerClose.getAttribute("aria-hidden")).toBe("true");
		expect(pointerClose.getAttribute("tabindex")).toBe("-1");
		expect(tabs()[0]?.getAttribute("aria-keyshortcuts")).toBe("Delete");
		// The chosen tab's close follows the list for a screen reader that has no Delete key.
		const selectedClose = document.querySelector("[data-tabs-close-selected]") as HTMLElement;
		expect(selectedClose.getAttribute("aria-label")).toBe("Close b");
		expect(selectedClose.closest("[role='tablist']")).toBeNull();

		await act(async () => pointerClose.click());
		expect(tabs().map(tab => tab.textContent)).toEqual(["B", "C"]);

		const event = new Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: "Delete" });
		await act(async () => {
			tabs()[0]?.dispatchEvent(event);
		});
		expect(tabs().map(tab => tab.textContent)).toEqual(["C"]);
		expect(selectedIds()).toEqual(["c"]);
		expect(focused.at(-1)).toBe("c");
	});

	it("forgets a Delete the caller did not carry out once focus leaves, so a later removal steals no focus", async () => {
		let setOpen: (ids: string[]) => void = () => {};
		function Asking() {
			const [open, set] = useState(["a", "b"]);
			setOpen = set;
			return (
				<>
					<Tabs
						activeId="a"
						onChange={() => {}}
						tabs={open.map(id => ({ id, label: id, onClose: () => {}, closeLabel: `Close ${id}` }))}
						variant="pills"
					/>
					<button data-elsewhere type="button">
						Elsewhere
					</button>
				</>
			);
		}
		const focused: string[] = [];
		vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
			focused.push(this.getAttribute("data-tab-id") ?? "");
		});
		await mount(<Asking />);
		const event = new Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: "Delete" });
		await act(async () => tabs()[0]?.dispatchEvent(event));
		expect(tabs()).toHaveLength(2);
		const blur = new Event("focusout", { bubbles: true });
		Object.defineProperty(blur, "relatedTarget", { value: document.querySelector("[data-elsewhere]") });
		await act(async () => tabs()[0]?.dispatchEvent(blur));
		await act(async () => setOpen(["b"]));
		expect(tabs()).toHaveLength(1);
		expect(focused).toEqual([]);
	});

	it("passes a tab's double click and its own keys on", async () => {
		const keep = vi.fn();
		await mount(
			<Tabs
				activeId="a"
				ariaLabel="Files"
				onChange={() => {}}
				tabs={[{ id: "a", label: "notes.md", keyshortcuts: "Meta+W", onDoubleClick: keep }]}
			/>,
		);
		expect(tabs()[0]?.getAttribute("aria-keyshortcuts")).toBe("Meta+W");
		await act(async () => {
			tabs()[0]?.dispatchEvent(new Event("dblclick", { bubbles: true }));
		});
		expect(keep).toHaveBeenCalledTimes(1);
	});

	it("stacks a vertical strip, says so, and moves with ↑/↓", async () => {
		const change = vi.fn();
		function Vertical() {
			const [active, setActive] = useState("a");
			return (
				<Tabs
					activeId={active}
					ariaLabel="Sections"
					onChange={id => {
						change(id);
						setActive(id);
					}}
					orientation="vertical"
					tabs={TABS}
					variant="pills"
				/>
			);
		}
		await mount(<Vertical />);
		expect(document.querySelector("[role='tablist']")?.getAttribute("aria-orientation")).toBe("vertical");
		await press("ArrowDown");
		await press("ArrowDown");
		await press("ArrowUp");
		expect(change.mock.calls.map(call => call[0])).toEqual(["b", "c", "b"]);
	});
});
