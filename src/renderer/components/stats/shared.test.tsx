import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { ko } from "../../locales/ko";
import { RouteFrame } from "./shared";

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

let container: HTMLElement;
let root: Root;
const realLocalStorage = (globalThis as Record<string, unknown>).localStorage;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	(globalThis as Record<string, unknown>).localStorage = realLocalStorage;
});

describe("RouteFrame", () => {
	it("headlines a coded stats failure with its Korean sentence and keeps the raw text as detail", async () => {
		(globalThis as Record<string, unknown>).localStorage = {
			getItem: (key: string) => (key === "omp.lang" ? "ko" : null),
			setItem: () => {},
		};
		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		// The shape main's stats:fetch handler hands back after StatsClient throws a coded error.
		const error = "[stats_api_error] Stats API error: 500 Internal Server Error";
		await act(async () => {
			root.render(
				<I18nProvider>
					<RouteFrame error={error} loading={false} onRetry={() => {}}>
						<p>rows</p>
					</RouteFrame>
				</I18nProvider>,
			);
		});

		const alert = container.querySelector('[role="alert"]');
		expect(alert?.textContent).toBe(ko["ipcError.stats_api_error"]);
		expect(container.textContent).toContain("Stats API error: 500 Internal Server Error");
		expect(container.textContent).not.toContain("[stats_api_error]");
		expect(container.textContent).not.toContain(ko["stats.unavailable"]);
	});
});
