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
	history: Array<{ id: number; url: string }> = [];
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
		if (method === "Page.getNavigationHistory") {
			return { currentIndex: this.history.length - 1, entries: this.history };
		}
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
		fake.emit("message", {}, "Target.attachedToTarget", {
			sessionId: "child-1",
			targetInfo: { type: "iframe", targetId: "frame-1" },
			waitingForDebugger: false,
		});
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

	it("refuses every method outside the page's own domains, and the dangerous ones inside them", async () => {
		const { fake, rpc } = setup();
		await rpc(1, { op: "attach", tabId: 7 });
		const refused = [
			"Target.getTargets",
			"Target.setDiscoverTargets",
			"Target.attachToTarget",
			"Target.attachToBrowserTarget",
			"Target.sendMessageToTarget",
			"Target.activateTarget",
			"Target.getTargetInfo",
			"Target.createTarget",
			"Target.closeTarget",
			"Target.createBrowserContext",
			"Target.disposeBrowserContext",
			"Target.exposeDevToolsProtocol",
			"DOM.setFileInputFiles",
			"Page.setInterceptFileChooserDialog",
			"Input.setInterceptDrags",
			"Page.close",
			"Page.crash",
			"Page.navigateToHistoryEntry",
			"Page.setDownloadBehavior",
			"Security.setIgnoreCertificateErrors",
			"Security.setOverrideCertificateErrors",
			"Security.handleCertificateError",
			"Browser.close",
			"Browser.getVersion",
			"SystemInfo.getInfo",
			"Tethering.bind",
			"Tracing.start",
			"Memory.getDOMCounters",
			"constructor",
			"toString",
			"__proto__.x",
			"",
		];
		for (const [index, method] of refused.entries()) {
			const result = await rpc(10 + index, { op: "send", tabId: 7, method, params: {} });
			expect(result?.ok, method).toBe(false);
			expect(refusedCommand(method, {}), method).not.toBeNull();
		}
		expect(fake.sent).toEqual([]);
	});

	it("forwards the commands stock's browser tool needs", async () => {
		const { fake, rpc } = setup();
		await rpc(1, { op: "attach", tabId: 7 });
		const allowed = [
			"Runtime.enable",
			"Runtime.callFunctionOn",
			"Page.enable",
			"Page.captureScreenshot",
			"Page.stopLoading",
			"Page.setWebLifecycleState",
			"Page.handleJavaScriptDialog",
			"DOM.getDocument",
			"Input.dispatchMouseEvent",
			"Network.enable",
			"Fetch.disable",
			"Emulation.setUserAgentOverride",
			"Inspector.enable",
			"Profiler.start",
			"Target.setAutoAttach",
		];
		for (const [index, method] of allowed.entries()) {
			expect((await rpc(100 + index, { op: "send", tabId: 7, method, params: {} }))?.ok, method).toBe(true);
		}
		expect(fake.sent.map(entry => entry.method)).toEqual(allowed);
	});

	it("lets stock's back and forward through: the history entry's URL is read first and must be http(s) or about:blank", async () => {
		const { fake, rpc } = setup();
		await rpc(1, { op: "attach", tabId: 7 });
		fake.history = [
			{ id: 1, url: "about:blank" },
			{ id: 2, url: "https://a.test/" },
			{ id: 3, url: "file:///etc/passwd" },
			{ id: 4, url: "chrome://gpu" },
		];
		const go = (id: number, entryId: unknown) =>
			rpc(id, { op: "send", tabId: 7, method: "Page.navigateToHistoryEntry", params: { entryId } });
		expect((await go(2, 1))?.ok).toBe(true);
		expect((await go(3, 2))?.ok).toBe(true);
		for (const [id, entryId] of [
			[4, 3],
			[5, 4],
			[6, 99],
			[7, "2"],
			[8, undefined],
		] as const) {
			expect((await go(id, entryId))?.ok, String(entryId)).toBe(false);
		}
		expect(fake.sent.map(entry => entry.method)).toEqual([
			"Page.getNavigationHistory",
			"Page.navigateToHistoryEntry",
			"Page.getNavigationHistory",
			"Page.navigateToHistoryEntry",
			"Page.getNavigationHistory",
			"Page.getNavigationHistory",
			"Page.getNavigationHistory",
		]);
		expect(
			fake.sent.filter(entry => entry.method === "Page.navigateToHistoryEntry").map(entry => entry.params),
		).toEqual([{ entryId: 1 }, { entryId: 2 }]);
	});

	it("answers Tracing with a reason the agent's tool error can show", async () => {
		const { fake, rpc } = setup();
		await rpc(1, { op: "attach", tabId: 7 });
		const result = await rpc(2, { op: "send", tabId: 7, method: "Tracing.start", params: {} });
		expect(result?.ok).toBe(false);
		expect(String(result?.error)).toMatch(/Tracing.*traceStart.*browser-wide/);
		expect(fake.sent).toEqual([]);
	});

	it("refuses a drag that carries files or file paths and forwards one that carries text", async () => {
		const { fake, rpc } = setup();
		await rpc(1, { op: "attach", tabId: 7 });
		const drag = (id: number, data: object) =>
			rpc(id, {
				op: "send",
				tabId: 7,
				method: "Input.dispatchDragEvent",
				params: { type: "drop", x: 1, y: 1, data },
			});
		for (const [id, data] of [
			[2, { items: [], files: ["/etc/hosts"] }],
			[3, { items: [], files: "/etc/hosts" }],
			[4, { items: [{ mimeType: "text/uri-list", data: "file:///etc/hosts" }] }],
		] as const) {
			const result = await drag(id, data);
			expect(result?.ok, JSON.stringify(data)).toBe(false);
			expect(String(result?.error)).toMatch(/files/);
		}
		expect(fake.sent).toEqual([]);
		expect((await drag(5, { items: [{ mimeType: "text/plain", data: "hello" }], files: [] }))?.ok).toBe(true);
		expect((await drag(6, { items: [{ mimeType: "text/plain", data: "hello" }] }))?.ok).toBe(true);
		expect(fake.sent.map(entry => entry.method)).toEqual(["Input.dispatchDragEvent", "Input.dispatchDragEvent"]);
	});

	it("only reaches sessions this page's own debugger announced", async () => {
		const { fake, rpc } = setup();
		await rpc(1, { op: "attach", tabId: 7 });
		// Never announced: for example a session the agent opened onto the app window.
		expect((await rpc(2, { op: "send", tabId: 7, sessionId: "app-window", method: "Runtime.evaluate" }))?.ok).toBe(
			false,
		);
		expect((await rpc(3, { op: "send", tabId: 7, sessionId: "", method: "Runtime.evaluate" }))?.ok).toBe(false);
		expect(fake.sent).toEqual([]);
		// A child of this page (an out-of-process frame) is announced and reachable until it detaches.
		fake.emit("message", {}, "Target.attachedToTarget", {
			sessionId: "frame-session",
			targetInfo: { type: "iframe", targetId: "frame-1" },
			waitingForDebugger: false,
		});
		expect((await rpc(4, { op: "send", tabId: 7, sessionId: "frame-session", method: "Runtime.enable" }))?.ok).toBe(
			true,
		);
		expect(
			(
				await rpc(5, {
					op: "send",
					tabId: 7,
					sessionId: "frame-session",
					method: "Target.setAutoAttach",
					params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
				})
			)?.ok,
		).toBe(true);
		// A session announced for another page-like target is not this page's child.
		fake.emit("message", {}, "Target.attachedToTarget", {
			sessionId: "other-page",
			targetInfo: { type: "page", targetId: "page-2" },
		});
		expect((await rpc(6, { op: "send", tabId: 7, sessionId: "other-page", method: "Runtime.evaluate" }))?.ok).toBe(
			false,
		);
		// Detaching a session needs a session that was announced.
		expect(
			(
				await rpc(7, {
					op: "send",
					tabId: 7,
					method: "Target.detachFromTarget",
					params: { sessionId: "app-window" },
				})
			)?.ok,
		).toBe(false);
		expect(
			(
				await rpc(8, {
					op: "send",
					tabId: 7,
					method: "Target.detachFromTarget",
					params: { sessionId: "frame-session" },
				})
			)?.ok,
		).toBe(true);
		fake.emit("message", {}, "Target.detachedFromTarget", { sessionId: "frame-session" });
		expect((await rpc(9, { op: "send", tabId: 7, sessionId: "frame-session", method: "Runtime.enable" }))?.ok).toBe(
			false,
		);
		// Announced sessions end with the debugger attachment.
		fake.emit("message", {}, "Target.attachedToTarget", {
			sessionId: "worker-session",
			targetInfo: { type: "worker", targetId: "worker-1" },
		});
		await rpc(10, { op: "detach", tabId: 7 });
		await rpc(11, { op: "attach", tabId: 7 });
		expect((await rpc(12, { op: "send", tabId: 7, sessionId: "worker-session", method: "Runtime.enable" }))?.ok).toBe(
			false,
		);
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
