import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { TrayState } from "../../shared/ipc-types";
import { WebChrome } from "./chrome";
import { mountConnectionBanner } from "./connection-banner";
import type { WsConnectionState } from "./ws-transport";

function page() {
	const { document } = parseHTML(
		'<html><head><title>OMPdesk</title><meta name="theme-color" content="#000" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)"></head><body></body></html>',
	);
	return document as unknown as Document;
}

const tray = (status: TrayState["status"]) => ({ status }) as TrayState;

describe("WebChrome", () => {
	it("marks the title and the app badge while a turn waits for an answer, and clears them after", () => {
		const doc = page();
		const badge: string[] = [];
		const chrome = new WebChrome({
			document: doc,
			navigator: {
				setAppBadge: async count => void badge.push(`set:${count}`),
				clearAppBadge: async () => void badge.push("clear"),
			},
		});
		chrome.applyTray(tray("approval"));
		expect(doc.title).toBe("(!) OMPdesk");
		chrome.applyTray(tray("input"));
		expect(doc.title).toBe("(!) OMPdesk");
		chrome.applyTray(tray("streaming"));
		expect(doc.title).toBe("OMPdesk");
		expect(badge).toEqual(["set:1", "set:1", "clear"]);
	});

	it("keeps a title the page changed in the meantime", () => {
		const doc = page();
		const chrome = new WebChrome({ document: doc, navigator: {} });
		chrome.applyTray(tray("approval"));
		doc.title = "Session A";
		chrome.applyTray(tray("idle"));
		expect(doc.title).toBe("Session A");
	});

	it("shows the progress bar while working and removes it when idle", () => {
		const doc = page();
		const chrome = new WebChrome({ document: doc, navigator: {} });
		chrome.applyProgress("working");
		expect(doc.getElementById("omp-web-progress")).not.toBeNull();
		chrome.applyProgress("waiting");
		expect(doc.querySelectorAll("#omp-web-progress")).toHaveLength(1);
		chrome.applyProgress("idle");
		expect(doc.getElementById("omp-web-progress")).toBeNull();
	});

	it("sets every theme-color to the top bar's color, whatever the OS scheme", () => {
		const doc = page();
		const chrome = new WebChrome({ document: doc, navigator: {} });
		chrome.applyColors({ color: "#123456", symbolColor: "#fff" });
		const metas = Array.from(doc.querySelectorAll('meta[name="theme-color"]'));
		expect(metas.map(meta => meta.getAttribute("content"))).toEqual(["#123456", "#123456"]);
		expect(metas.some(meta => meta.hasAttribute("media"))).toBe(false);
	});
});

describe("the connection banner", () => {
	function source(initial: WsConnectionState) {
		const listeners = new Set<(state: WsConnectionState) => void>();
		const handle = {
			state: initial,
			onState: (listener: (state: WsConnectionState) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		return {
			handle,
			set: (state: WsConnectionState) => {
				handle.state = state;
				for (const l of listeners) l(state);
			},
		};
	}

	it("shows a bar while reconnecting and removes it when the link is back", () => {
		const doc = page();
		const { handle, set } = source("open");
		mountConnectionBanner(handle, doc, key => key);
		expect(doc.getElementById("omp-web-connection")).toBeNull();
		set("reconnecting");
		expect(doc.getElementById("omp-web-connection")?.textContent).toBe("web.connection.lost");
		set("open");
		expect(doc.getElementById("omp-web-connection")).toBeNull();
	});

	it("waits a moment before showing a first connection, so a quick one never flashes", () => {
		const doc = page();
		const timers: (() => void)[] = [];
		const { handle, set } = source("connecting");
		mountConnectionBanner(
			handle,
			doc,
			key => key,
			callback => timers.push(callback) - 1,
			() => undefined,
		);
		expect(doc.getElementById("omp-web-connection")).toBeNull();
		timers[0]?.();
		expect(doc.getElementById("omp-web-connection")?.textContent).toBe("web.connection.connecting");
		set("open");
		expect(doc.getElementById("omp-web-connection")).toBeNull();
	});

	it("says so when the page is outdated or the device unpaired", () => {
		const doc = page();
		const { handle, set } = source("open");
		mountConnectionBanner(handle, doc, key => key);
		set("outdated");
		expect(doc.getElementById("omp-web-connection")?.textContent).toBe("web.connection.outdated");
		set("unpaired");
		expect(doc.getElementById("omp-web-connection")?.textContent).toBe("web.connection.unpaired");
	});
});
