/**
 * ModelSetupEntry: the last proposal's stamp reads as a bare time on the day
 * it was made and carries its date on any later day.
 * linkedom harness per AGENTS.md (never mock.module).
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { MODEL_SETUP_PREFS_KEY } from "./model-setup-logic";

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

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import time.
const { createRoot } = await import("react-dom/client");
const { ModelSetupEntry } = await import("./ModelSetupEntry");

const NOW = new Date(2026, 9, 14, 15, 0);

let root: Root | undefined;
let container: InstanceType<typeof HTMLElement> | undefined;

function storeProposal(savedAt: number): void {
	const proposal = {
		savedAt,
		researchModel: "anthropic/opus",
		models: ["anthropic/opus"],
		plan: { assignments: [], advisor: { enable: false, reason: "" }, sources: [] },
		dropped: [],
	};
	Object.assign(window, {
		omp: {
			prefs: {
				get: vi.fn(async (key: string) => (key === MODEL_SETUP_PREFS_KEY ? { local: proposal } : undefined)),
			},
		},
	});
}

async function description(): Promise<string> {
	container = document.createElement("div");
	document.body.appendChild(container);
	const mountRoot = createRoot(container);
	root = mountRoot;
	await act(async () => {
		mountRoot.render(
			<I18nProvider>
				<ModelSetupEntry />
			</I18nProvider>,
		);
	});
	return container.textContent ?? "";
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	container = undefined;
	vi.useRealTimers();
});

describe("ModelSetupEntry", () => {
	it("shows only the time for a proposal made today", async () => {
		storeProposal(new Date(2026, 9, 14, 10, 37).getTime());
		const text = await description();
		expect(text).toContain("Last proposal: 10:37.");
	});

	it("adds the date for a proposal from an earlier day", async () => {
		storeProposal(new Date(2026, 9, 12, 10, 37).getTime());
		const text = await description();
		expect(text).toMatch(/Last proposal: Oct 12, 10:37\./);
	});

	it("adds the year for a proposal from an earlier year", async () => {
		storeProposal(new Date(2025, 11, 30, 9, 5).getTime());
		const text = await description();
		expect(text).toMatch(/Last proposal: Dec 30, 2025, 09:05\./);
	});
});
