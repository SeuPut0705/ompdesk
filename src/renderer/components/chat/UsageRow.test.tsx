/**
 * Contract tests for the usage row segments added in phase B1 (plan/17 §7.3):
 * TTFT rides the message object (sibling of duration), timestamp renders as
 * HH:MM. Both must only appear when the message actually carries them.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { UsageRow } from "./UsageRow";

function render(message: AgentMessage): string {
	return renderToStaticMarkup(
		<I18nProvider>
			<UsageRow message={message} />
		</I18nProvider>,
	);
}

const baseMessage: AgentMessage = {
	role: "assistant",
	content: [{ type: "text", text: "answer" }],
	model: "kimi-k3",
	duration: 2400,
	usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } },
};

// zustand SSR note: useSyncExternalStore's server snapshot is the store's
// INITIAL state, so setState is invisible to renderToStaticMarkup. The tests
// drive the store gate by temporarily mutating the initial-state object
// (restored after each test) — no module mocks.
const initial = useSettingsStore.getInitialState();

beforeEach(() => {
	initial.showTokenUsage = true;
});

afterEach(() => {
	initial.showTokenUsage = false;
});

describe("UsageRow TTFT and time segments", () => {
	it("renders TTFT when the message carries it", () => {
		const html = render({ ...baseMessage, ttft: 350 });
		expect(html).toContain("TTFT");
	});

	it("omits the TTFT segment when absent", () => {
		const html = render(baseMessage);
		expect(html).not.toContain("TTFT");
	});

	it("renders an HH:MM time from an ISO timestamp", () => {
		const html = render({ ...baseMessage, timestamp: "2026-08-05T14:30:00.000Z" });
		const date = new Date("2026-08-05T14:30:00.000Z");
		const expected = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		expect(html).toContain(expected);
	});

	it("renders an HH:MM time from epoch-ms", () => {
		const ms = Date.parse("2026-08-05T14:30:00.000Z");
		const html = render({ ...baseMessage, timestamp: ms });
		const date = new Date(ms);
		const expected = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		expect(html).toContain(expected);
	});

	it("omits the time segment when the timestamp is missing", () => {
		const html = render({ ...baseMessage, ttft: 350 });
		// No timestamp on the message: the row renders other segments but no trailing time chip.
		expect(html).not.toMatch(/>\d{2}:\d{2}</);
	});

	it("stays hidden when showTokenUsage is off (schema default)", () => {
		initial.showTokenUsage = false;
		const html = render({ ...baseMessage, ttft: 350, timestamp: "2026-08-05T14:30:00.000Z" });
		expect(html).toBe("");
	});
});
