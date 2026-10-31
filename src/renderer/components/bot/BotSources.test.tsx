import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useBotActivityStore } from "../../stores/bot-activity";
import { useMessagesStore } from "../../stores/messages";
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

describe("a reply that names no sources", () => {
	afterEach(() => {
		useMessagesStore.setState({ messages: [] } as never);
		useBotActivityStore.getState().reset();
	});

	it("shows what its turn read, and nothing for an earlier reply of the same turn", async () => {
		const user = { role: "user", content: "How many files?", timestamp: Date.UTC(2026, 10, 1, 9, 0, 0) };
		const early = {
			role: "assistant",
			content: [{ type: "text", text: "Looking." }],
			timestamp: Date.UTC(2026, 10, 1, 9, 0, 5),
		};
		const last = {
			role: "assistant",
			content: [{ type: "text", text: "Three." }],
			timestamp: Date.UTC(2026, 10, 1, 9, 0, 30),
		};
		useMessagesStore.setState({ messages: [user, early, last] } as never);
		const entries = [
			{
				id: "a",
				at: "2026-11-01T08:59:00.000Z",
				kind: "read",
				action: "tool",
				by: "bot",
				text: "read",
				target: { type: "file", value: "/before.ts" },
			},
			{
				id: "b",
				at: "2026-11-01T09:00:10.000Z",
				kind: "read",
				action: "tool",
				by: "bot",
				text: "read",
				target: { type: "file", value: "/src/count.ts" },
			},
		];
		(window as unknown as { omp: unknown }).omp = {
			fs: { read: async () => ({ ok: false, code: "not_found" }) },
			sessions: { botDesk: { activity: async () => ({ entries, revision: 1 }) } },
		};
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () =>
			root.render(
				<I18nProvider>
					<BotTabContext.Provider value={{ tabId: "t1" }}>
						<AssistantText message={last as never} text="Three." />
						<AssistantText message={early as never} text="Looking." />
					</BotTabContext.Provider>
				</I18nProvider>,
			),
		);
		const groups = [...host.querySelectorAll("[data-bot-sources]")];
		expect(groups).toHaveLength(1);
		expect(groups[0]?.getAttribute("data-bot-sources")).toBe("derived");
		expect([...host.querySelectorAll("[data-kind]")].map(chip => chip.textContent)).toEqual(["count.ts"]);
		act(() => root.unmount());
	});
});
