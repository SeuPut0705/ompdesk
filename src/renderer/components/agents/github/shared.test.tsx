/**
 * GitHub Actions run state (linkedom): a finished run that neither succeeded nor failed names its conclusion in the
 * UI's language, and one GitHub adds later as GitHub spells it.
 */

import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider, setLanguageOverride } from "../../../lib/i18n";
import { RunState } from "./shared";

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

async function stateText(status: string, conclusion: string): Promise<string | null> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	container = host;
	root = createRoot(host as unknown as Element);
	await act(async () =>
		root?.render(createElement(I18nProvider, null, createElement(RunState, { status, conclusion }))),
	);
	return host.querySelector(".sr-only")?.textContent ?? null;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	setLanguageOverride(null);
});

describe("RunState", () => {
	it("names a finished run's conclusion in Korean", async () => {
		setLanguageOverride("ko");
		expect(await stateText("completed", "cancelled")).toBe("끝남: 취소됨");
	});

	it("names it in English with GitHub's underscores gone", async () => {
		setLanguageOverride("en");
		expect(await stateText("completed", "action_required")).toBe("Finished: action required");
	});

	it("reads a state GitHub adds later as GitHub spells it", async () => {
		setLanguageOverride("ko");
		expect(await stateText("completed", "brand_new_state")).toBe("끝남: brand new state");
	});
});
