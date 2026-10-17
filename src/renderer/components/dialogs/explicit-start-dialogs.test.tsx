/**
 * Dialogs that act on the outside world do nothing on open: /share shows a local preview and uploads only on
 * "Upload and create link"; /live and /btw open their start surface and send `live_start` / `btw` only from their
 * Start / Ask button; /tools, /debug and the model benchmark open on reads alone.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionRpcClient } from "../../../shared/rpc-client";
import type { RpcCommand, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { ActiveToolsDialog } from "./ActiveToolsDialog";
import { BenchmarkDialog } from "./BenchmarkDialog";
import { BtwDialog } from "./BtwDialog";
import { DebugConsoleDialog } from "./DebugConsoleDialog";
import { LiveVoiceDialog } from "./LiveVoiceDialog";
import { ShareSessionDialog } from "./ShareSessionDialog";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	CustomEvent,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

let root: Root | undefined;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	useUiStore.setState({ shareSessionOpen: false, liveOpen: false, btwRequest: null });
	useSessionStore.getState().reset();
});

const DATA: Record<string, unknown> = {
	preview_share_session: {
		snapshotId: "snap-1",
		preview: "user: hi",
		store: "server",
		serverUrl: "http://127.0.0.1/",
		redactionEnabled: true,
	},
	live_start: { voice: "alloy" },
	btw: { record: { id: "b1", question: "q", answer: "", status: "running", startedAt: 0 } },
	get_active_tools: { tools: [] },
};

/** Every command the dialogs send, answered with a canned success. */
function connect() {
	const sent: string[] = [];
	const transport = async (command: RpcCommand): Promise<RpcResponse> => {
		sent.push(command.type === "debug" ? `debug:${command.params.action}` : command.type);
		const data =
			command.type === "share_session" ? { url: "http://127.0.0.1/shared#local" } : (DATA[command.type] ?? {});
		return { type: "response", command: command.type, success: true, data };
	};
	const bench = { run: vi.fn(), abort: vi.fn() };
	Object.assign(window, {
		omp: {
			rpc: createSessionRpcClient(transport),
			events: { onLiveFrame: () => () => {}, onBtwFrame: () => () => {} },
			system: { openExternal: vi.fn() },
			bench,
		},
	});
	useSessionStore.setState({ status: "ready" });
	return { sent, bench };
}

async function mount(node: React.ReactNode): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => root?.render(<I18nProvider>{node}</I18nProvider>));
	await settle();
}

async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++)
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});
}

async function click(label: string): Promise<void> {
	const button = Array.from(document.querySelectorAll("button")).find(
		candidate => candidate.textContent?.trim() === label,
	);
	if (!button) throw new Error(`no button "${label}"`);
	await act(async () => (button as unknown as HTMLButtonElement).click());
	await settle();
}

describe("dialogs that start something only on a click", () => {
	it("share previews locally and uploads only from its button", async () => {
		const { sent } = connect();
		useUiStore.setState({ shareSessionOpen: true });
		await mount(<ShareSessionDialog />);
		expect(document.body.textContent).toContain("user: hi");
		const uploads = () => sent.filter(type => type !== "preview_share_session");
		expect(uploads()).toEqual([]);
		await click(translate("shareDialog.upload"));
		expect(uploads()).toHaveLength(1);
		expect(document.body.textContent).toContain("http://127.0.0.1/shared#local");
	});

	it("live voice connects only from Start", async () => {
		const { sent } = connect();
		useUiStore.setState({ liveOpen: true });
		await mount(<LiveVoiceDialog />);
		expect(document.querySelector("[role=dialog]")).not.toBeNull();
		expect(sent).toEqual([]);
		await click(translate("live.start"));
		expect(sent).toEqual(["live_start"]);
	});

	it("a side question is asked only from Ask, with the text it opened with", async () => {
		const { sent } = connect();
		useUiStore.setState({ btwRequest: "explain the current approach" });
		await mount(<BtwDialog />);
		expect(document.querySelector("[role=dialog]")).not.toBeNull();
		expect(sent).toEqual([]);
		await click(translate("btw.ask"));
		expect(sent).toEqual(["btw"]);
	});

	it("tools, debug and the benchmark open on reads alone", async () => {
		const { sent, bench } = connect();
		useUiStore.setState({ activeToolsOpen: true, debugOpen: true });
		await mount(
			<>
				<ActiveToolsDialog />
				<DebugConsoleDialog />
				<BenchmarkDialog open onClose={() => {}} />
			</>,
		);
		expect(document.querySelectorAll("[role=dialog]").length).toBeGreaterThan(0);
		expect([...new Set(sent)].sort()).toEqual(["debug:sessions", "get_active_tools"]);
		expect(bench.run).not.toHaveBeenCalled();
	});
});
