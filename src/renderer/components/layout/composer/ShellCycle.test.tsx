/**
 * Shell polish contracts found by the shell audit (e2e/shell-audit.e2e.ts):
 * the composer's model chip keeps a glyph once the narrow toolbar hides its
 * name, an empty composer never shows a scrollbar for a wrapped placeholder,
 * and the command palette and theme picker search through the shared
 * SearchField instead of a bare input with its own focus outline.
 */
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { ko } from "../../../locales/ko";
import { useSessionStore } from "../../../stores/session";
import { useUiStore } from "../../../stores/ui";
import { CommandPalette } from "../../dialogs/CommandPalette";
import { ThemePickerDialog } from "../../dialogs/ThemePickerDialog";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};
if (typeof elementPrototype.attachEvent !== "function") elementPrototype.attachEvent = () => {};
if (typeof elementPrototype.detachEvent !== "function") elementPrototype.detachEvent = () => {};

const stylesheet = readFileSync(new URL("../../../styles/components.css", import.meta.url), "utf8");
const inputArea = readFileSync(new URL("./InputArea.tsx", import.meta.url), "utf8");

/** Bodies of every `@container <query> { … }` block, braces balanced. */
function containerBlocks(query: string): string {
	const blocks: string[] = [];
	let from = 0;
	for (;;) {
		const start = stylesheet.indexOf(`@container ${query} {`, from);
		if (start === -1) return blocks.join("\n");
		let depth = 0;
		let end = start;
		for (; end < stylesheet.length; end++) {
			if (stylesheet[end] === "{") depth++;
			else if (stylesheet[end] === "}" && --depth === 0) break;
		}
		blocks.push(stylesheet.slice(start, end + 1));
		from = end + 1;
	}
}

/** Declarations of the top-level rule whose selector list is exactly `selector`. */
function topLevelRule(selector: string): string {
	const start = stylesheet.indexOf(`\n${selector} {`);
	if (start === -1) return "";
	return stylesheet.slice(start, stylesheet.indexOf("}", start));
}

describe("narrow composer toolbar", () => {
	it("gives the model chip a glyph that shows only once its name is hidden", () => {
		expect(inputArea).toMatch(/data-model-chip[\s\S]{0,400}omp-composer-model-icon/);
		expect(topLevelRule(".omp-composer-model-icon")).toContain("display: none");
		const narrow = containerBlocks("omp-workspace (max-width: 560px)");
		expect(narrow).toContain(".omp-composer-model-label");
		expect(narrow).toMatch(/\.omp-composer-model-icon\s*\{[^}]*display:\s*block/);
	});

	it("keeps an empty composer's placeholder on one clipped line", () => {
		expect(inputArea).toMatch(/<textarea[\s\S]{0,4000}omp-composer-input/);
		const rule = topLevelRule(".omp-composer-input:placeholder-shown");
		expect(rule).toContain("overflow: hidden");
		expect(rule).toContain("white-space: nowrap");
	});
});

let root: Root | undefined;
let container: HTMLElement | undefined;

async function render(node: React.ReactNode): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as unknown as Node);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(<I18nProvider>{node}</I18nProvider>);
	});
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	document.body.innerHTML = "";
	useUiStore.setState({ commandPaletteOpen: false, themePickerOpen: false });
	useSessionStore.getState().reset();
	vi.restoreAllMocks();
});

describe("picker search fields", () => {
	it("the command palette searches through the shared search field", async () => {
		useSessionStore.setState({ status: "ready" });
		Reflect.set(window, "omp", {
			rpc: {
				getAvailableCommands: vi.fn(async () => ({ type: "response", success: true, data: { commands: [] } })),
			},
		});
		useUiStore.setState({ commandPaletteOpen: true });
		await render(<CommandPalette />);
		const input = document.body.querySelector("input");
		expect(input?.getAttribute("type")).toBe("search");
		expect(input?.className).toContain("bg-(--sc-field)");
	});

	it("the theme picker searches through the shared search field", async () => {
		Reflect.set(window, "omp", { prefs: { get: vi.fn(async () => undefined) } });
		useUiStore.setState({ themePickerOpen: true });
		await render(<ThemePickerDialog />);
		const input = document.body.querySelector("input");
		expect(input?.getAttribute("type")).toBe("search");
		expect(input?.className).toContain("bg-(--sc-field)");
	});

	it.each(["BranchPickerDialog", "SessionPickerDialog"])("the %s searches through the shared search field", name => {
		const source = readFileSync(new URL(`../../dialogs/${name}.tsx`, import.meta.url), "utf8");
		expect(source).toContain("<SearchField");
		expect(source).not.toMatch(/<input\b/);
	});

	it("the session picker's toggles are shared IconButtons with tooltips, not bare title buttons", () => {
		const source = readFileSync(new URL("../../dialogs/SessionPickerDialog.tsx", import.meta.url), "utf8");
		expect(source.match(/<IconButton\b/g)).toHaveLength(3);
		// No native title tooltips; the failure notice's `title` is its heading, not a tooltip.
		expect(source.match(/\btitle=\{[^}]*\}/g)).toEqual(["title={error.message}"]);
		expect(source).toMatch(/<InlineNotice[\s\S]*?title=\{error\.message\}/);
		// A long project path keeps its tail, so the message count and age after it stay visible.
		expect(source).toContain("shortenPath(session.cwd)");
	});

	it("the import dialog switches source with shared Tabs and filters through the shared search field", () => {
		const source = readFileSync(new URL("../../dialogs/ImportForeignDialog.tsx", import.meta.url), "utf8");
		expect(source).toContain("<Tabs");
		expect(source).toContain("<SearchField");
		expect(source).toContain("<EmptyState");
		expect(source).not.toMatch(/<Input\b|aria-pressed=/);
	});

	it("the history search footer shows its keys as Kbd chips like the palette, not as one plain sentence", () => {
		const source = readFileSync(new URL("./HistorySearchOverlay.tsx", import.meta.url), "utf8");
		expect(source.match(/<Kbd shortcut=/g)?.length).toBeGreaterThanOrEqual(3);
		expect(source).not.toContain('t("input.history.hint")');
	});

	it("the model picker keeps its default hint as the footer tooltip, not as a line of its own", () => {
		const picker = readFileSync(new URL("../../dialogs/ModelPicker.tsx", import.meta.url), "utf8");
		expect(picker).toMatch(/title=\{t\("modelPicker\.defaultHint"\)\}/);
		expect(picker).not.toMatch(/<span[^>]*>\s*\{t\("modelPicker\.defaultHint"\)/);
	});
});

describe("first-run copy", () => {
	it("the Korean later hint does not open with the Set up later button's own words", () => {
		expect(ko["setup.laterHint"].startsWith(ko["setup.later"])).toBe(false);
	});
});
