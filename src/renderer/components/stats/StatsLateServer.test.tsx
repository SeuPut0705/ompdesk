/**
 * A stats section on a server that is down: it says so within seconds, a
 * section opened while the server is known to be down says so at once instead
 * of spinning through the boot budget again, and a server that binds late
 * fills the open section with no reload or retry click.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { FrustrationData } from "../../../shared/stats-types";
import { I18nProvider } from "../../lib/i18n";
import { en } from "../../locales/en";
import { FrustrationRoute } from "./FrustrationRoute";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const DATA: FrustrationData = {
	overall: { messages: 200, judged: 50, annoyed: 20, atAssistant: 10, angry: 2 },
	byModel: [],
};

let ready = false;
const fetch = vi.fn(async () =>
	ready ? DATA : { error: "Starting in the background.", unavailable: true, stopped: false },
);
const roots: Root[] = [];

async function mount(): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container as unknown as globalThis.Element);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider>
				<FrustrationRoute range="30d" />
			</I18nProvider>,
		);
	});
	return container as unknown as HTMLElement;
}

async function advance(ms: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	vi.useRealTimers();
});

it("says the server is down within seconds, keeps that across sections, and fills in when it binds late", async () => {
	vi.useFakeTimers();
	Object.assign(window, { omp: { stats: { fetch } }, setTimeout, clearTimeout, setInterval, clearInterval });

	const first = await mount();
	expect(first.textContent).toContain(en["stats.loading"]);
	await advance(10_000);
	expect(first.textContent).toContain(en["stats.serverDown"]);

	// Another section opened while the server is known to be down: no second boot spinner.
	await act(async () => roots.pop()?.unmount());
	const second = await mount();
	expect(second.textContent).toContain(en["stats.serverDown"]);
	expect(second.textContent).not.toContain(en["stats.loading"]);

	ready = true;
	await advance(5_000);
	expect(second.textContent).toContain("50 of 200 messages have a model verdict");
	expect(second.textContent).not.toContain(en["stats.serverDown"]);
});
