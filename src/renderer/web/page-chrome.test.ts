import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { TrayState } from "../../shared/ipc-types";
import { WebChrome } from "./chrome";

function page() {
	const { document } = parseHTML(
		'<html><head><title>OMPdesk</title><meta name="theme-color" content="#000" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)"></head><body></body></html>',
	);
	return document as unknown as Document;
}

const tray = (status: TrayState["status"]) => ({ status }) as TrayState;

describe("WebChrome", () => {
	it("marks the title and the app badge while the session needs the person, and clears them after", () => {
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
		chrome.applyTray(tray("childWaiting"));
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
