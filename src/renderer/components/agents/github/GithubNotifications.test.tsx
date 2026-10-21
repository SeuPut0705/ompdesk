/**
 * GitHub notifications (linkedom): a row names what it is about and why it came in the UI's language, and a kind or
 * reason GitHub adds later as GitHub spells it.
 */

import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubNotification } from "../../../../shared/github";
import { I18nProvider, setLanguageOverride } from "../../../lib/i18n";
import { GithubNotifications } from "./GithubNotifications";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

// react-dom must load after linkedom's globals above, so this import cannot be static.
const { createRoot } = await import("react-dom/client");

let root: Root | undefined;
let container: { remove: () => void } | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	setLanguageOverride(null);
});

const ROW: GithubNotification = {
	id: "1",
	unread: true,
	reason: "review_requested",
	title: "Add a thing",
	type: "PullRequest",
	repo: "o/r",
	updatedAt: "2026-10-21T00:00:00Z",
	url: "https://github.com/o/r/pull/7",
};

async function mount(rows: GithubNotification[]): Promise<Element> {
	(window as unknown as { omp: unknown }).omp = {
		rpc: { command: async () => ({ type: "response", command: "github", success: true, data: rows }) },
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	container = host;
	root = createRoot(host as unknown as Element);
	await act(async () =>
		root?.render(
			createElement(I18nProvider, null, createElement(GithubNotifications, { target: {}, targetKey: "k" })),
		),
	);
	return host as unknown as Element;
}

describe("GitHub notifications", () => {
	it("names a notification's kind and reason in Korean", async () => {
		setLanguageOverride("ko");
		const host = await mount([ROW]);
		expect(host.querySelector("[data-github-notification-type]")?.textContent).toBe("풀 리퀘스트");
		expect(host.querySelector("[data-github-notification-reason]")?.textContent).toBe("리뷰 요청");
	});

	it("reads a kind or reason GitHub adds later as GitHub spells it", async () => {
		setLanguageOverride("ko");
		const host = await mount([{ ...ROW, type: "BrandNewThing", reason: "brand_new_reason" }]);
		expect(host.querySelector("[data-github-notification-type]")?.textContent).toBe("BrandNewThing");
		expect(host.querySelector("[data-github-notification-reason]")?.textContent).toBe("brand new reason");
	});
});
