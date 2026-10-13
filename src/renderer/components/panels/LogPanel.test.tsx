/**
 * The log toolbar's count says what it counts, and an empty log shows only its
 * waiting state, not a bare "0".
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { LogBatch } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { LogPanel } from "./LogPanel";

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

let root: Root | null = null;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

async function mount(snapshot: LogBatch): Promise<HTMLElement> {
	Object.assign(window, {
		omp: { runtime: { logSnapshot: async () => snapshot }, events: { onLogBatch: () => () => {} } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<LogPanel />
			</I18nProvider>,
		);
	});
	return container as unknown as HTMLElement;
}

it("labels the line count and drops it while the log is empty", async () => {
	const empty = await mount({ lines: [], nextSequence: 0 });
	expect(empty.querySelector("[data-log-count]")).toBeNull();
	expect(empty.textContent).toContain("Waiting for log output…");
	await act(async () => root?.unmount());
	root = null;

	const full = await mount({ lines: ["[info] ready", "[warn] slow"], nextSequence: 2 });
	expect(full.querySelector("[data-log-count]")?.textContent).toBe("2 lines");
});
