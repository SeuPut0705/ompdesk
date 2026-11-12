/**
 * Settings › Updates & about › This computer › Disk: the value line says the total OMPdesk uses and what the last run
 * freed, the breakdown and the run's action totals sit in the row's info text, and "Clean up" runs disk care and is
 * off (with its own spinner) while one runs.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiskCareState } from "../../../shared/disk-care";
import { I18nProvider, translate } from "../../lib/i18n";
import { resetLastReadForTest } from "../../lib/last-read";
import { DiskCareRow } from "./DiskCareRow";

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

const GB = 1_073_741_824;

function diskState(partial: Partial<DiskCareState> = {}): DiskCareState {
	return {
		running: false,
		automatic: true,
		usage: {
			measuredAt: 1,
			total: 12 * GB,
			parts: [
				{ id: "worktrees", bytes: 8 * GB, path: "/w" },
				{ id: "scratch", bytes: 1 * GB, path: "/s" },
				{ id: "bunCache", bytes: 2 * GB, path: "/b" },
				{ id: "bunTranspilerCache", bytes: 7 * GB, path: "/t" },
				{ id: "npmCache", bytes: 3 * GB, path: "/n" },
			],
		},
		lastRun: {
			trigger: "daily",
			startedAt: Date.now() - 1000,
			endedAt: Date.now(),
			freedBytes: 3 * GB,
			actions: [{ kind: "artifacts", count: 4, bytes: 3 * GB }],
			kept: 0,
			failed: 0,
		},
		...partial,
	};
}

let listener: ((state: DiskCareState) => void) | null = null;
const current = { state: diskState() };
const api = {
	getState: vi.fn(async () => current.state),
	run: vi.fn(async () => current.state),
	onState: vi.fn((callback: (state: DiskCareState) => void) => {
		listener = callback;
		return () => {
			listener = null;
		};
	}),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { diskCare: api } });

let root: Root | null = null;
async function mount(state: DiskCareState): Promise<void> {
	current.state = state;
	root = createRoot(document.body as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<DiskCareRow />
			</I18nProvider>,
		),
	);
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}
const button = () => document.body.querySelector("[data-testid='disk-care-clean']") as HTMLButtonElement;
const status = () => document.body.querySelector("[data-testid='disk-care-status']")?.textContent;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	resetLastReadForTest();
	for (const fn of Object.values(api)) fn.mockClear();
});

describe("DiskCareRow", () => {
	it("shows the total and what the last run freed, with the breakdown in the info text", async () => {
		await mount(diskState());
		expect(status()).toContain("12.0 GB");
		expect(status()).toContain("3.0 GB");
		const info = document.body.textContent ?? "";
		expect(info).toContain(`${translate("diskCare.part.worktrees")}: 8.0 GB`);
		expect(info).toContain(translate("diskCare.action.artifacts", { count: 4, size: "3.0 GB" }));
	});

	it("lists the session scratch files and each tool's cache as parts, and what was left in place", async () => {
		await mount(
			diskState({
				lastRun: {
					trigger: "daily",
					startedAt: 1,
					endedAt: 2,
					freedBytes: 8 * GB,
					actions: [
						{ kind: "bun-transpiler-cache", count: 1, bytes: 7 * GB },
						{ kind: "scratch", count: 3, bytes: 1 * GB },
					],
					kept: 2,
					failed: 0,
				},
			}),
		);
		const info = document.body.textContent ?? "";
		for (const line of [
			`${translate("diskCare.part.scratch")}: 1.0 GB`,
			`${translate("diskCare.part.bunCache")}: 2.0 GB`,
			`${translate("diskCare.part.bunTranspilerCache")}: 7.0 GB`,
			`${translate("diskCare.part.npmCache")}: 3.0 GB`,
			translate("diskCare.action.bun-transpiler-cache", { count: 1, size: "7.0 GB" }),
			translate("diskCare.action.scratch", { count: 3, size: "1.0 GB" }),
			translate("diskCare.kept", { count: 2 }),
		])
			expect(info, line).toContain(line);
	});

	it("runs disk care from the button and is off while a run goes", async () => {
		await mount(diskState());
		expect(button().disabled).toBe(false);
		await act(async () => button().click());
		expect(api.run).toHaveBeenCalledTimes(1);
		await act(async () => listener?.(diskState({ running: true })));
		expect(button().disabled).toBe(true);
		await act(async () => listener?.(diskState({ running: false })));
		expect(button().disabled).toBe(false);
	});

	it("says measuring only while a first run goes, and nothing cleaned before one", async () => {
		await mount(diskState({ usage: null, lastRun: null, running: true }));
		expect(status()).toBe(translate("diskCare.measuring"));
		await act(async () => listener?.(diskState({ usage: null, lastRun: null, running: false })));
		expect(status()).toBe(translate("diskCare.neverRun"));
	});
});
