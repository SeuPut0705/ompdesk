/**
 * What a person sends while the link to the computer is down waits in the outbox (stores/outbox.ts) and goes once
 * the link is back (lib/outbox-delivery.ts): in order, each once, and never silently dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcOpenExtensionRequest } from "../../shared/ipc-types";
import type { ExtensionUIRequest, RpcCommand, RpcResponse } from "../../shared/rpc-types";
import type { ExtensionUiStore } from "../stores/extension-ui";
import type { SessionTab } from "../stores/tabs";
import type { WebRuntime } from "../web/runtime";
import type { WsConnectionState } from "../web/ws-transport";

const stored = new Map<string, string>();
vi.stubGlobal("localStorage", {
	getItem: (key: string) => stored.get(key) ?? null,
	setItem: (key: string, value: string) => stored.set(key, value),
	removeItem: (key: string) => stored.delete(key),
});

const commandForTab = vi.fn<(tabId: string, command: RpcCommand) => Promise<RpcResponse>>();
const respondExtensionUi = vi.fn<(response: unknown, tabId?: string) => Promise<void>>();
const openRequests = vi.fn<() => Promise<IpcOpenExtensionRequest[]>>();
vi.stubGlobal("window", { omp: { rpc: { commandForTab }, ui: { respondExtensionUi, openRequests } } });

let link: WsConnectionState = "reconnecting";
const linkListeners = new Set<(state: WsConnectionState) => void>();
function setLink(state: WsConnectionState): void {
	link = state;
	for (const listener of linkListeners) listener(state);
}

const ok: RpcResponse = { type: "response", command: "prompt", success: true };

/**
 * A fresh page: every module read again, the outbox from what the last one stored. Imported dynamically after
 * `vi.resetModules()`: the reload is the boundary under test, and each page needs its own module graph.
 */
async function page() {
	vi.resetModules();
	const runtime = await import("../web/runtime");
	runtime.setWebRuntime({
		connectionState: () => link,
		onConnectionState: listener => {
			linkListeners.add(listener);
			return () => linkListeners.delete(listener);
		},
	} as Partial<WebRuntime> as WebRuntime);
	const delivery = await import("./outbox-delivery");
	const { useOutboxStore } = await import("../stores/outbox");
	const { useTabsStore } = await import("../stores/tabs");
	const { useToastStore } = await import("../stores/toast");
	const { translate } = await import("./i18n");
	const tab = {
		id: "t1",
		cwd: "/p",
		status: "ready",
		kind: "agent",
		sessionId: "s1",
		unreadDone: false,
	} as SessionTab;
	useTabsStore.setState({ tabs: [tab] });
	return { ...delivery, useOutboxStore, useTabsStore, useToastStore, translate, tab };
}

const sentPrompts = () =>
	commandForTab.mock.calls.flatMap(([, command]) =>
		command.type === "prompt" ? [{ message: command.message, deliveryId: command.deliveryId }] : [],
	);

let stop: (() => void) | undefined;

beforeEach(() => {
	stored.clear();
	linkListeners.clear();
	link = "reconnecting";
	commandForTab.mockReset().mockResolvedValue(ok);
	respondExtensionUi.mockReset().mockResolvedValue(undefined);
	openRequests.mockReset().mockResolvedValue([]);
});

afterEach(() => {
	stop?.();
	stop = undefined;
	vi.useRealTimers();
});

describe("outbox delivery", () => {
	it("holds messages while the link is down and sends each once, in order, with its own id, when it is back", async () => {
		const { holdMessage, sendsHeld, installOutboxDelivery, useOutboxStore, tab } = await page();
		stop = installOutboxDelivery();
		expect(sendsHeld(tab)).toBe(true);
		holdMessage(tab, { text: "one", images: [], behavior: "steer" });
		holdMessage(tab, { text: "two", images: [], behavior: "followUp" });
		await Promise.resolve();
		expect(commandForTab).not.toHaveBeenCalled();
		const ids = useOutboxStore.getState().items.map(item => item.id);

		setLink("open");
		await vi.waitFor(() => expect(useOutboxStore.getState().items).toEqual([]));
		expect(sentPrompts()).toEqual([
			{ message: "one", deliveryId: ids[0] },
			{ message: "two", deliveryId: ids[1] },
		]);
		expect(commandForTab.mock.calls.find(([, command]) => command.type === "prompt")?.[1]).toMatchObject({
			streamingBehavior: "steer",
		});
	});

	it("keeps what waits across a reload, and a send a reload cut off waits again with the same id", async () => {
		const first = await page();
		first.holdMessage(first.tab, { text: "one", images: [], behavior: "steer" });
		first.holdMessage(first.tab, { text: "two", images: [], behavior: "steer" });
		const [id] = first.useOutboxStore.getState().items.map(item => item.id);
		if (!id) throw new Error("nothing held");
		first.useOutboxStore.getState().patch(id, { state: "sending" });

		const second = await page();
		expect(second.useOutboxStore.getState().items.map(item => [item.send, item.state])).toEqual([
			[{ kind: "message", text: "one", images: [], behavior: "steer" }, "held"],
			[{ kind: "message", text: "two", images: [], behavior: "steer" }, "held"],
		]);
		setLink("open");
		stop = second.installOutboxDelivery();
		await vi.waitFor(() => expect(second.useOutboxStore.getState().items).toEqual([]));
		expect(sentPrompts()[0]).toEqual({ message: "one", deliveryId: id });
	});

	it("tries a send the link cut again with the same id, and stops at one the computer refused until it is retried", async () => {
		vi.useFakeTimers();
		const { holdMessage, installOutboxDelivery, useOutboxStore, tab } = await page();
		holdMessage(tab, { text: "cut", images: [], behavior: "steer" });
		holdMessage(tab, { text: "refused", images: [], behavior: "steer" });
		holdMessage(tab, { text: "after", images: [], behavior: "steer" });
		// The first try of "cut" is lost on the link, every try of "refused" until the person retries it is refused.
		let cutTries = 0;
		let refusing = true;
		commandForTab.mockImplementation(async (_tabId, command) => {
			if (command.type !== "prompt") return ok;
			if (command.message === "cut" && cutTries++ === 0)
				return { ...ok, success: false, code: "rpc_delivery_unknown", error: "lost" };
			if (command.message === "refused" && refusing) return { ...ok, success: false, error: "no model" };
			return ok;
		});
		setLink("open");
		stop = installOutboxDelivery();
		await vi.waitFor(
			() =>
				expect(useOutboxStore.getState().items.map(item => [item.state, item.error])).toEqual([
					["failed", "no model"],
					["held", undefined],
				]),
			{ timeout: 10_000, interval: 100 },
		);
		const prompts = sentPrompts();
		expect(prompts.map(prompt => prompt?.message)).toEqual(["cut", "cut", "refused"]);
		expect(prompts[0]?.deliveryId).toBe(prompts[1]?.deliveryId);

		const refused = useOutboxStore.getState().items[0];
		if (!refused) throw new Error("the refused message is gone");
		refusing = false;
		useOutboxStore.getState().patch(refused.id, { state: "held", error: undefined });
		await vi.waitFor(() => expect(useOutboxStore.getState().items).toEqual([]), { timeout: 10_000, interval: 100 });
		expect(sentPrompts().map(prompt => prompt?.message)).toEqual(["cut", "cut", "refused", "refused", "after"]);
	});

	it("never sends an answer to a question that closed meanwhile, and says so", async () => {
		vi.useFakeTimers();
		const { holdAnswer, installOutboxDelivery, useOutboxStore, useToastStore, translate, tab } = await page();
		const request: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: "ask-1",
			method: "confirm",
			title: "Deploy?",
			message: "Deploy now?",
		};
		const { sessionRuntimeStore } = await import("../stores/session-runtime-context");
		const { ensureTabRuntime } = await import("../stores/tab-runtime");
		ensureTabRuntime(tab.id);
		sessionRuntimeStore<ExtensionUiStore>(tab.id, "extensionUi")?.getState().pushRequest(request);
		holdAnswer(tab, { type: "extension_ui_response", id: "ask-1", confirmed: true });
		const summary = translate("common.yes");
		expect(useOutboxStore.getState().items[0]?.send).toMatchObject({ kind: "answer", request, summary });

		setLink("open");
		stop = installOutboxDelivery();
		await vi.waitFor(() => expect(useOutboxStore.getState().items).toEqual([]), { timeout: 10_000, interval: 100 });
		expect(respondExtensionUi).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts.map(toast => toast.message)).toEqual([
			translate("outbox.answerClosed", { summary }),
		]);
	});

	it("sends an answer whose question is still open to the process that asked", async () => {
		const { holdAnswer, installOutboxDelivery, useOutboxStore, tab } = await page();
		const response = { type: "extension_ui_response" as const, id: "ask-2", value: "Staging" };
		holdAnswer(tab, response);
		setLink("open");
		stop = installOutboxDelivery();
		await vi.waitFor(() => expect(useOutboxStore.getState().items).toEqual([]));
		expect(respondExtensionUi).toHaveBeenCalledWith(response, "t1");
	});
});
