/**
 * The preview's relay "extension" speaks stock's wire protocol
 * (tools/browser/relay/protocol.ts) over a fake per-page debugger, refuses
 * what would leave the page or http(s), and only dials stock's loopback relay.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { PreviewRelayExtension, type RelayDebugger, refusedCommand, relayExtensionUrl } from "./agent-relay";

class FakeDebugger extends EventEmitter {
	attached = false;
	rendered = false;
	sent: Array<{ method: string; params?: object; sessionId?: string }> = [];
	attach(): void {
		if (this.attached) throw new Error("already attached");
		this.attached = true;
	}
	detach(): void {
		this.attached = false;
		this.emit("detach", {}, "target closed");
	}
	isAttached(): boolean {
		return this.attached;
	}
	async sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown> {
		this.sent.push({ method, params, sessionId });
		return method === "Runtime.evaluate" ? { result: { type: "string", value: "Example" } } : undefined;
	}
}

function setup() {
	const fake = new FakeDebugger();
	const posted: Array<Record<string, unknown>> = [];
	const activity: string[] = [];
	const extension = new PreviewRelayExtension(
		{
			id: 7,
			url: () => "https://example.com/",
			title: () => "Example",
			userAgent: () => "Mozilla/5.0 Chrome/138.0.7204.0 Electron/36.9.5",
			// The fake implements the slice the relay uses; Electron's overloads are not reproducible here.
			debugger: fake as unknown as RelayDebugger,
			ensureRenderer: async () => {
				fake.rendered = true;
			},
		},
		message => posted.push(message as Record<string, unknown>),
		method => activity.push(method),
	);
	const rpc = async (id: number, body: Record<string, unknown>) => {
		extension.handle(JSON.stringify({ t: "rpc", id, ...body }));
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
		return posted.find(message => message.t === "rpcResult" && message.id === id);
	};
	return { fake, posted, activity, extension, rpc };
}

describe("preview relay extension", () => {
	it("says hello with the one preview tab in stock's discarded-tabs protocol", () => {
		const { extension } = setup();
		expect(extension.hello("ompdesk-preview-x")).toEqual({
			t: "hello",
			instanceId: "ompdesk-preview-x",
			userAgent: "Mozilla/5.0 Chrome/138.0.7204.0 Electron/36.9.5",
			browserVersion: "Chrome/138.0.7204.0",
			discardedTabsProtocol: 1,
			tabs: [
				{
					tabId: 7,
					url: "https://example.com/",
					title: "Example",
					active: true,
					discarded: false,
					windowId: 1,
					pinned: false,
					groupId: -1,
				},
			],
			attachedTabIds: [],
		});
	});

	it("attaches, forwards commands and events with session ids, and reports activity", async () => {
		const { fake, posted, activity, rpc } = setup();
		expect(await rpc(1, { op: "attach", tabId: 7 })).toEqual({ t: "rpcResult", id: 1, ok: true, result: {} });
		expect(fake.attached).toBe(true);
		expect(fake.rendered).toBe(true);
		expect(
			await rpc(2, { op: "send", tabId: 7, method: "Runtime.evaluate", params: { expression: "document.title" } }),
		).toEqual({ t: "rpcResult", id: 2, ok: true, result: { result: { type: "string", value: "Example" } } });
		await rpc(3, { op: "send", tabId: 7, sessionId: "child-1", method: "Runtime.enable" });
		expect(fake.sent.map(entry => [entry.method, entry.sessionId])).toEqual([
			["Runtime.evaluate", undefined],
			["Runtime.enable", "child-1"],
		]);
		fake.emit("message", {}, "Page.loadEventFired", { timestamp: 1 }, "child-1");
		expect(posted.at(-1)).toEqual({
			t: "cdpEvent",
			tabId: 7,
			sessionId: "child-1",
			method: "Page.loadEventFired",
			params: { timestamp: 1 },
		});
		expect(activity).toEqual(["attach", "Runtime.evaluate", "Runtime.enable"]);
	});

	it("refuses navigation off http(s), browser-wide commands and new or closed tabs", async () => {
		const { fake, rpc } = setup();
		await rpc(1, { op: "attach", tabId: 7 });
		for (const [id, body] of [
			[2, { op: "send", tabId: 7, method: "Page.navigate", params: { url: "file:///etc/passwd" } }],
			[3, { op: "send", tabId: 7, method: "Page.setDownloadBehavior", params: { behavior: "allow" } }],
			[4, { op: "send", tabId: 7, method: "Browser.setDownloadBehavior", params: {} }],
			[5, { op: "createTab", url: "https://example.org/" }],
			[6, { op: "removeTab", tabId: 7 }],
			[7, { op: "send", tabId: 99, method: "Runtime.enable" }],
		] as const) {
			expect((await rpc(id, body))?.ok).toBe(false);
		}
		expect(fake.sent).toEqual([]);
		expect(
			(await rpc(8, { op: "send", tabId: 7, method: "Page.navigate", params: { url: "https://a.test/" } }))?.ok,
		).toBe(true);
		expect((await rpc(9, { op: "group", tabIds: [7], title: "omp", color: "cyan" }))?.result).toEqual({
			grouped: {},
		});
	});

	it("marks a relay-requested detach and releases the debugger on dispose", async () => {
		const { fake, posted, extension, rpc } = setup();
		await rpc(1, { op: "attach", tabId: 7 });
		await rpc(2, { op: "detach", tabId: 7 });
		expect(posted.find(message => message.t === "detached")).toEqual({
			t: "detached",
			tabId: 7,
			reason: "target closed",
			relayInitiated: true,
		});
		await rpc(3, { op: "attach", tabId: 7 });
		extension.dispose();
		expect(fake.attached).toBe(false);
		expect(fake.listenerCount("message")).toBe(0);
		expect((await rpc(4, { op: "attach", tabId: 7 }))?.ok).toBe(false);
	});

	it("checks commands and the relay endpoint", () => {
		expect(refusedCommand("Page.navigate", { url: "about:blank" })).toBeNull();
		expect(refusedCommand("Page.navigate", { url: "javascript:alert(1)" })).not.toBeNull();
		expect(refusedCommand("Input.dispatchMouseEvent", {})).toBeNull();
		expect(refusedCommand("SystemInfo.getInfo", {})).not.toBeNull();
		const token = "abcdefghijklmnopqrstuvwxyz012345";
		expect(relayExtensionUrl("http://127.0.0.1:9333", token)).toBe(`ws://127.0.0.1:9333/ext?token=${token}`);
		expect(relayExtensionUrl("http://localhost:9333", token)).toBeNull();
		expect(relayExtensionUrl("http://127.0.0.1:9333/x", token)).toBeNull();
		expect(relayExtensionUrl("https://127.0.0.1:9333", token)).toBeNull();
		expect(relayExtensionUrl("http://127.0.0.1:9333", "short")).toBeNull();
	});
});
