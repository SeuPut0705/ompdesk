/**
 * AsyncSection: one truthful state, by precedence. A failed read is never an empty collection, a reload never blanks
 * rows already shown (the error becomes a banner over them), and an empty list is only empty once loaded without error.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { AsyncSection, type AsyncSectionProps } from "./AsyncSection";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

async function render(props: Partial<AsyncSectionProps>) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<AsyncSection
					emptyLabel="Nothing here"
					error={null}
					errorTitle="Could not load"
					loading={false}
					staleLabel="Showing the last list"
					{...props}
				>
					<ul data-rows>
						<li>row</li>
					</ul>
				</AsyncSection>
			</I18nProvider>,
		),
	);
	return {
		rows: () => host.querySelector("[data-rows]"),
		alert: () => host.querySelector("[role=alert]")?.textContent ?? null,
		text: () => host.textContent ?? "",
		busy: () => host.querySelector("[aria-busy]"),
		retry: () => host.querySelector("button"),
	};
}

describe("AsyncSection", () => {
	it("shows a placeholder on the first load and the rows once loaded", async () => {
		const first = await render({ loading: true });
		expect(first.busy()).not.toBeNull();
		expect(first.rows()).toBeNull();
		await act(async () => root?.unmount());
		const loaded = await render({});
		expect(loaded.rows()).not.toBeNull();
	});

	it("keeps the rows on screen while it loads again", async () => {
		const view = await render({ loading: true, hasData: true });
		expect(view.rows()).not.toBeNull();
		expect(view.busy()).toBeNull();
	});

	it("names a failed first read as a failure with Retry, never as an empty list", async () => {
		const onRetry = vi.fn();
		const view = await render({ error: "ECONNRESET", empty: true, onRetry });
		expect(view.alert()).toBe("Could not load");
		expect(view.text()).not.toContain("Nothing here");
		expect(view.rows()).toBeNull();
		await act(async () => view.retry()?.click());
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("keeps the last rows under a banner when a reload fails", async () => {
		const view = await render({ error: "ECONNRESET", hasData: true });
		expect(view.rows()).not.toBeNull();
		expect(view.text()).toContain("Showing the last list");
		expect(view.alert()).toBeNull();
	});

	it("says empty only for a loaded empty collection", async () => {
		const view = await render({ empty: true });
		expect(view.text()).toContain("Nothing here");
		expect(view.rows()).toBeNull();
	});
});
