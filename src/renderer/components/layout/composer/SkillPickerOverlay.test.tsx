import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import.
const { createRoot } = await import("react-dom/client");
const { SkillPickerOverlay, filterSkills } = await import("./SkillPickerOverlay");
const { oneLine } = await import("../../../lib/format");

const LONG = `Use when the user asks to research social platforms.\n\nSupports many backends.\n\n${"More detail that goes on and on. ".repeat(20)}`;
const SKILLS = [
	{ name: "agent-reach", description: LONG },
	{ name: "caveman", description: "Ultra-compressed talk" },
	{ name: "caveman-commit", description: "Terse commit messages" },
	{ name: "review", description: "Review a change" },
];

let container: HTMLElement;
let root: Root;
const onSelect = vi.fn();
const onManage = vi.fn();
const onClose = vi.fn();

async function mount(skills = SKILLS): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			createElement(I18nProvider, null, createElement(SkillPickerOverlay, { skills, onSelect, onManage, onClose })),
		);
	});
}

function reactProps<T>(node: object): T {
	const record = node as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	return record[key ?? ""] as T;
}

const names = () =>
	Array.from(document.querySelectorAll("[data-skill-row]")).map(row => row.getAttribute("data-skill-row"));

async function search(value: string): Promise<void> {
	const input = document.querySelector("input") as unknown as HTMLInputElement;
	input.value = value;
	await act(async () =>
		reactProps<{ onChange(event: object): void }>(input).onChange({ target: input, currentTarget: input }),
	);
}

async function key(name: string): Promise<void> {
	const input = document.querySelector("input") as unknown as HTMLInputElement;
	await act(async () =>
		reactProps<{ onKeyDown(event: object): void }>(input).onKeyDown({
			key: name,
			preventDefault() {},
			stopPropagation() {},
			nativeEvent: { isComposing: false, keyCode: 0 },
		}),
	);
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.clearAllMocks();
});

describe("SkillPickerOverlay", () => {
	it("renders one line per skill: name plus a single-line ellipsized description, full text in the tooltip", async () => {
		await mount();
		const row = document.querySelector('[data-skill-row="agent-reach"]') as unknown as HTMLElement;
		const description = row.querySelector("[data-skill-description]") as unknown as HTMLElement;
		expect(description.className).toContain("truncate");
		expect(description.textContent).not.toContain("\n");
		expect(description.textContent).toBe(oneLine(LONG));
		expect(row.querySelectorAll("span").length).toBe(2);
		expect(row.getAttribute("title")).toBe(`agent-reach\n${oneLine(LONG)}`);
		const panel = document.querySelector("[data-skill-picker]") as unknown as HTMLElement;
		expect(panel.className).toContain("max-h-[60vh]");
		expect(panel.className).toContain("bottom-full");
	});

	it("filters by name first, then description, and says when nothing matches", async () => {
		await mount();
		await search("caveman");
		expect(names()).toEqual(["caveman", "caveman-commit"]);
		await search("terse");
		expect(names()).toEqual(["caveman-commit"]);
		await search("zzz");
		expect(names()).toEqual([]);
		expect(document.querySelector("[data-skill-picker]")?.textContent).toContain("No matching skills.");
	});

	it("moves with the arrow keys and Enter inserts the highlighted skill", async () => {
		await mount();
		await key("ArrowDown");
		await key("ArrowDown");
		const selected = () =>
			Array.from(document.querySelectorAll("[data-skill-row]")).findIndex(
				row => row.getAttribute("aria-selected") === "true",
			);
		expect(selected()).toBe(2);
		// The pointer moves the highlight itself: no row draws a hover tint beside the keyboard's.
		const rows = Array.from(document.querySelectorAll("[data-skill-row]"));
		expect(rows.some(row => (row.getAttribute("class") ?? "").includes("hover:"))).toBe(false);
		await key("ArrowUp");
		expect(selected()).toBe(1);
		await key("Enter");
		expect(onSelect).toHaveBeenCalledWith("caveman");
	});

	it("filterSkills ranks name prefixes before description hits", () => {
		const hits = filterSkills(
			[
				{ name: "zeta", description: "mentions review" },
				{ name: "review-pr", description: "" },
			],
			"review",
		);
		expect(hits.map(hit => hit.name)).toEqual(["review-pr", "zeta"]);
	});

	it("shows the empty hint when no skill is on, and Manage still opens settings", async () => {
		await mount([]);
		expect(document.querySelector("[data-skill-picker]")?.textContent).toContain("No skills are on");
		const manage = document.querySelector("[data-skill-manage]") as unknown as HTMLElement;
		await act(async () => reactProps<{ onClick(): void }>(manage).onClick());
		expect(onManage).toHaveBeenCalled();
	});
});
