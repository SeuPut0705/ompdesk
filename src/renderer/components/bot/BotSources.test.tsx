import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
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
	});

	const user = { role: "user", content: "How many files?", timestamp: 1 };
	const tools = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/src/count.ts" } },
			{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "git show 3f6bd016 --stat" } },
			{ type: "toolCall", id: "c3", name: "ompdesk_bot", arguments: { action: "activity" } },
		],
		timestamp: 2,
	};
	const early = { role: "assistant", content: [{ type: "text", text: "Looking." }], timestamp: 3 };
	const last = { role: "assistant", content: [{ type: "text", text: "Three." }], timestamp: 4 };

	function render(messages: unknown[], replies: { message: unknown; text: string }[]): HTMLElement {
		useMessagesStore.setState({ messages } as never);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		act(() =>
			root.render(
				<I18nProvider>
					<BotTabContext.Provider value={{ tabId: "t1" }}>
						{replies.map(reply => (
							<AssistantText key={reply.text} message={reply.message as never} text={reply.text} />
						))}
					</BotTabContext.Provider>
				</I18nProvider>,
			),
		);
		return host;
	}

	it("shows what its turn's own tool calls read, on the turn's last reply only", () => {
		const host = render(
			[user, early, tools, last],
			[
				{ message: last, text: "Three." },
				{ message: early, text: "Looking." },
			],
		);
		const groups = [...host.querySelectorAll("[data-bot-sources]")];
		expect(groups.map(group => group.getAttribute("data-bot-sources"))).toEqual(["derived"]);
		expect(
			[...host.querySelectorAll("[data-kind]")].map(chip => [chip.getAttribute("data-kind"), chip.textContent]),
		).toEqual([
			["file", "count.ts"],
			["commit", "3f6bd01"],
		]);
	});

	it("keeps them however much the bot did since, and after a reload, as they come from the saved transcript", () => {
		// Hundreds of later turns, and a fresh store read back from the session: the old reply still names its sources.
		const later = Array.from({ length: 300 }, (_, turn) => [
			{ role: "user", content: `q${turn}`, timestamp: 10 + turn * 3 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: `x${turn}`, name: "read", arguments: { path: `/later/${turn}.ts` } }],
				timestamp: 11 + turn * 3,
			},
			{ role: "assistant", content: [{ type: "text", text: `a${turn}` }], timestamp: 12 + turn * 3 },
		]).flat();
		const reloaded = JSON.parse(JSON.stringify([user, early, tools, last, ...later]));
		const host = render(reloaded, [{ message: reloaded[3], text: "Three." }]);
		expect([...host.querySelectorAll("[data-kind]")].map(chip => chip.textContent)).toEqual(["count.ts", "3f6bd01"]);
	});
});
