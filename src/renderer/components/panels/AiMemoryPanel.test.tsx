import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiMemoryState } from "../../../shared/ai-memory";
import { useAiMemoryStore } from "../../stores/ai-memory";
import { useMemoryPageStore } from "../../stores/memory-page";
import { useUiStore } from "../../stores/ui";
import {
	button,
	cleanup,
	click,
	fakeMemoryApi,
	handoff,
	installApi,
	memoryState,
	mount,
	q,
	qa,
	ref,
	text,
} from "../settings/memory/memory-test-harness";
import { AiMemoryPanel } from "./AiMemoryPanel";

let api = fakeMemoryApi();

async function show(state: AiMemoryState) {
	useAiMemoryStore.setState({ state });
	api.getState.mockResolvedValue(state);
	await mount(<AiMemoryPanel />);
}

beforeEach(() => {
	api = fakeMemoryApi();
	api.recent.mockResolvedValue([
		ref("sessions/s1.md", "Session one", { kind: "session" }),
		ref("notes/n.md", "A note"),
	]);
	api.handoffs.mockResolvedValue([
		handoff("h-open", "open", { summary: "Wire the tests" }),
		handoff("h-old", "accepted"),
	]);
	installApi(api);
});
afterEach(cleanup);

describe("Side panel › Memory", () => {
	it("shows status and counts, recent pages and only open handoffs", async () => {
		await show(memoryState());
		const header = text("[data-ai-memory-header]");
		expect(header).toContain("Running");
		expect(header).toContain("5 pages · 2 sessions · 9 observations");
		expect(api.recent).toHaveBeenCalledWith();
		expect(text("[data-ai-memory-recent]")).toContain("Session one");
		const handoffs = text("[data-ai-memory-handoffs]");
		expect(handoffs).toContain("Wire the tests");
		expect(handoffs).not.toContain("Summary of h-old");
	});

	it("Open Memory opens the Memory page in Settings", async () => {
		await show(memoryState());
		await click(q("[data-memory-open]"));
		expect(useUiStore.getState().destination).toBe("settings");
		expect(useUiStore.getState().settingsTab).toBe("memory");
	});

	it("a page row opens that page on the Memory page", async () => {
		await show(memoryState());
		await click(q('[data-ai-memory-page="notes/n.md"]'));
		expect(useMemoryPageStore.getState().pending).toMatchObject({ path: "notes/n.md" });
		expect(useUiStore.getState().settingsTab).toBe("memory:pages");
	});

	it("opens the web console from the header", async () => {
		await show(memoryState());
		await click(button("Open web console"));
		expect(api.openWeb).toHaveBeenCalledOnce();
	});

	it.each([
		["off", "Memory is off. Turn it on in Settings › Memory."],
		["unreachable", "Memory isn't answering."],
		["failed", "Memory couldn't start."],
		["starting", "Memory is starting…"],
		["unsupported", "Memory isn't available on this system."],
	] as const)("shows the %s message and reads nothing", async (phase, message) => {
		await show(memoryState({ phase, enabled: phase !== "off", stats: null, detail: "details here" }));
		expect(text(`[data-ai-memory-unavailable="${phase}"]`)).toContain(message);
		expect(api.recent).not.toHaveBeenCalled();
		expect(api.handoffs).not.toHaveBeenCalled();
		expect(qa("[data-ai-memory-recent]")).toHaveLength(0);
	});
});
