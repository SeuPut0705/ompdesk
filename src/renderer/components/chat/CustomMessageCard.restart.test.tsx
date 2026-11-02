import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { CustomMessageCard } from "./CustomMessageCard";
import { WorkNotes } from "./work/WorkNotes";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

// 2 Nov 2026, the 0.94.0 → 0.94.1 update restart: each revived subagent ended at once, stock delivered
// "failed in 353ms" with its empty-message warning, and the row read as a failure.
const WARNING = "SYSTEM WARNING: Subagent ended without a final message.";
const note = (subagents: Array<Record<string, unknown>>): AgentMessage => ({
	role: "custom",
	customType: "ompdesk-restart-subagents",
	timestamp: 1,
	display: true,
	content: "These background agents you started are working again",
	details: { jobs: [], subagents },
});
const delivery = (inner = `<output>\n${WARNING}\n</output>`, jobId = "LayoutSplit"): AgentMessage => ({
	role: "custom",
	customType: "async-result",
	timestamp: 2,
	display: true,
	content: `<system-notice>\nBackground job ${jobId} has failed.\n<task-result id="${jobId}" agent="task" status="failed (exit 1)" duration="353ms">\n${inner}\n</task-result>\n</system-notice>`,
	details: { jobs: [{ jobId, agentId: jobId, type: "task", status: "failed", label: jobId, durationMs: 353 }] },
});
const named = note([{ id: "LayoutSplit", intent: "Split the layout", doing: "bash: probing the stream" }]);

let container: { remove: () => void; textContent: string | null; innerHTML: string };
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as typeof container;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
}
/** The row's output stays out of the page until its disclosure opens. */
async function openRow(): Promise<void> {
	const row = (container as unknown as Element).querySelector('button[aria-expanded="false"]');
	await act(async () => row?.dispatchEvent(new Event("click", { bubbles: true })));
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useMessagesStore.setState({ messages: [], liveMessages: [] });
	vi.unstubAllGlobals();
});

describe("an async-result row of a subagent a restart cut", () => {
	it.each([
		["en", "Interrupted by the restart"],
		["ko", "재시작으로 중단됨"],
	])("reads %s as interrupted, with what it was doing, no duration and no stock warning", async (language, label) => {
		vi.stubGlobal("localStorage", { getItem: () => language, setItem: vi.fn() });
		const message = delivery();
		useMessagesStore.setState({ messages: [named, message], liveMessages: [] });
		await mount(<CustomMessageCard message={message} />);
		expect(container.textContent).toContain(label);
		await openRow();
		expect(container.textContent).toContain("bash: probing the stream");
		expect(container.textContent).not.toContain("SYSTEM WARNING");
		expect(container.textContent).not.toContain("353ms");
		expect(container.textContent).not.toMatch(/failed|실패/i);
		expect(container.innerHTML).not.toContain("--omp-error");
	});

	it("falls back to the note's intent, then to nothing, for what it was doing", async () => {
		const message = delivery();
		useMessagesStore.setState({
			messages: [note([{ id: "LayoutSplit", intent: "Split the layout" }]), message],
			liveMessages: [],
		});
		await mount(<CustomMessageCard message={message} />);
		await openRow();
		expect(container.textContent).toContain("Split the layout");
		await act(async () => root.unmount());
		container.remove();
		useMessagesStore.setState({ messages: [note([{ id: "LayoutSplit" }]), message], liveMessages: [] });
		await mount(<CustomMessageCard message={message} />);
		expect(container.textContent).toContain("Interrupted by the restart");
		expect(container.textContent).not.toContain("SYSTEM WARNING");
	});

	it("reads a delivery that is still a live message, behind the note the transcript committed", async () => {
		const message = delivery();
		useMessagesStore.setState({ messages: [named], liveMessages: [message] });
		await mount(<CustomMessageCard message={message} />);
		expect(container.textContent).toContain("Interrupted by the restart");
	});

	it("stays a failure when no note names it or the agent died of a real error", async () => {
		const plain = delivery();
		useMessagesStore.setState({ messages: [plain], liveMessages: [] });
		await mount(<CustomMessageCard message={plain} />);
		expect(container.textContent).toContain("Background job failed");
		expect(container.textContent).toContain("353ms");
		expect(container.innerHTML).toContain("--omp-error");
		await act(async () => root.unmount());
		container.remove();
		const broken = delivery("<error>Provider stream error</error>\n<output>\nhalf a sentence\n</output>");
		useMessagesStore.setState({ messages: [named, broken], liveMessages: [] });
		await mount(<CustomMessageCard message={broken} />);
		expect(container.textContent).toContain("Background job failed");
		expect(container.textContent).not.toContain("Interrupted by the restart");
	});

	it("leaves the run's note line unfailed too, with what it was doing as its preview", async () => {
		const message = delivery();
		useMessagesStore.setState({ messages: [named, message], liveMessages: [] });
		await mount(<WorkNotes messages={[message]} />);
		expect(container.innerHTML).not.toContain("omp-work-notes-failed");
		expect(container.textContent).toContain("bash: probing the stream");
		expect(container.textContent).not.toContain("SYSTEM WARNING");
		await act(async () => root.unmount());
		container.remove();
		useMessagesStore.setState({ messages: [message], liveMessages: [] });
		await mount(<WorkNotes messages={[message]} />);
		expect(container.innerHTML).toContain("omp-work-notes-failed");
	});
});
