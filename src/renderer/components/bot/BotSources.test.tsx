import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { AssistantText } from "./BotSources";
import { BotTabContext } from "./bot-tab";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
(window as unknown as Record<string, unknown>).omp = { fs: { read: async () => ({ ok: false, code: "not_found" }) } };
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const REPLY = "Three files changed.\n\nSources: src/a.ts:4 · abc1234 · https://x.dev · notes";

function mount(bot: boolean): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const node = (
		<I18nProvider>
			<AssistantText text={REPLY} />
		</I18nProvider>
	);
	act(() => root.render(bot ? <BotTabContext.Provider value={{ tabId: "t1" }}>{node}</BotTabContext.Provider> : node));
	return host;
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("AssistantText", () => {
	it("shows chips with their kinds in the bot's pane, without the raw line", () => {
		const host = mount(true);
		const chips = [...host.querySelectorAll("[data-kind]")];
		expect(chips.map(c => [c.getAttribute("data-kind"), c.textContent])).toEqual([
			["file", "src/a.ts:4"],
			["commit", "abc1234"],
			["url", "https://x.dev"],
			["text", "notes"],
		]);
		expect(host.textContent).not.toContain("Sources: src/a.ts");
	});
	it("keeps the raw line outside the bot's pane", () => {
		const host = mount(false);
		expect(host.querySelectorAll("[data-kind]")).toHaveLength(0);
		expect(host.textContent).toContain("Sources: src/a.ts:4");
	});
});
