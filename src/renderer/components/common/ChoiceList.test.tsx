/**
 * ChoiceList: numbered rows that answer by click with their key and index; in a choosing mode a radio group or a group
 * of checkboxes that says which rows are checked; ↑/↓ move over the enabled rows and wrap.
 */

import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOUCH_QUERY } from "../../hooks/shell-queries";
import { resetShellModeForTests } from "../../hooks/use-shell-mode";
import { ChoiceList, type ChoiceListOption } from "./ChoiceList";

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

const CHOICES: ChoiceListOption[] = [
	{ key: "yes", label: "Yes", description: "Run it now" },
	{ key: "later", label: "Later", disabled: true },
	{ key: "no", label: "No", tone: "danger" },
];

async function mount(node: ReactNode) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () => root?.render(node));
	return Array.from(document.querySelectorAll("[data-choice]")) as unknown as HTMLButtonElement[];
}

async function press(target: HTMLElement, key: string) {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "key", { value: key });
	await act(async () => target.dispatchEvent(event));
}

describe("ChoiceList", () => {
	it("numbers plain action rows and answers a click with the row's key and index", async () => {
		const onChoose = vi.fn();
		const rows = await mount(<ChoiceList choices={CHOICES} onChoose={onChoose} />);
		expect(document.querySelector("[data-choice-list]")?.hasAttribute("role")).toBe(false);
		expect(rows.map(row => row.textContent)).toEqual(["1YesRun it now", "2Later", "3No"]);
		expect(rows.some(row => row.hasAttribute("aria-checked"))).toBe(false);
		await act(async () => rows[2]?.click());
		expect(onChoose).toHaveBeenCalledWith("no", 2);
	});

	it("is a radio group or a group of checkboxes that says which rows are checked", async () => {
		let rows = await mount(
			<ChoiceList choices={CHOICES} labelledBy="q" mode="single" onChoose={() => {}} selected={new Set(["no"])} />,
		);
		const group = document.querySelector("[data-choice-list]");
		expect(group?.getAttribute("role")).toBe("radiogroup");
		expect(group?.getAttribute("aria-labelledby")).toBe("q");
		expect(rows.map(row => [row.getAttribute("role"), row.getAttribute("aria-checked")])).toEqual([
			["radio", "false"],
			["radio", "false"],
			["radio", "true"],
		]);
		await act(async () => root?.unmount());
		rows = await mount(
			<ChoiceList choices={CHOICES} mode="multi" onChoose={() => {}} selected={new Set(["yes", "no"])} />,
		);
		expect(document.querySelector("[data-choice-list]")?.getAttribute("role")).toBe("group");
		expect(rows.map(row => row.getAttribute("role"))).toEqual(["checkbox", "checkbox", "checkbox"]);
		expect(rows.map(row => row.getAttribute("aria-checked"))).toEqual(["true", "false", "true"]);
	});

	it("moves focus with the arrows over the enabled rows, wrapping at the ends", async () => {
		let focused: HTMLElement | null = null;
		const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
			focused = this;
		});
		try {
			const rows = await mount(<ChoiceList choices={CHOICES} onChoose={() => {}} />);
			await press(rows[0] as HTMLElement, "ArrowDown");
			expect(focused).toBe(rows[2]);
			await press(rows[2] as HTMLElement, "ArrowDown");
			expect(focused).toBe(rows[0]);
			await press(rows[0] as HTMLElement, "ArrowUp");
			expect(focused).toBe(rows[2]);
		} finally {
			focus.mockRestore();
		}
	});

	it("draws no number keys on a touch screen, and marks a checked row with a ✓ in its box", async () => {
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
			let rows = await mount(<ChoiceList choices={CHOICES} onChoose={() => {}} />);
			expect(rows.map(row => row.textContent)).toEqual(["YesRun it now", "Later", "No"]);
			await act(async () => root?.unmount());
			rows = await mount(
				<ChoiceList choices={CHOICES} mode="multi" onChoose={() => {}} selected={new Set(["no"])} />,
			);
			expect(rows.map(row => row.textContent)).toEqual(["YesRun it now", "Later", "No"]);
			expect(rows.map(row => row.querySelector("svg") !== null)).toEqual([false, false, true]);
		} finally {
			Reflect.deleteProperty(window, "matchMedia");
			Reflect.deleteProperty(document.documentElement.dataset, "platform");
			resetShellModeForTests();
		}
	});
});
