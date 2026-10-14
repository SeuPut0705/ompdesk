/**
 * Settings › General › This computer: every item in install order with its
 * required/optional tag, a quiet notice (no Retry) for an item that can't be
 * installed automatically, Retry for a failed optional item, and nothing on
 * platforms OMPdesk doesn't set up.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETUP_ITEMS, type SetupState } from "../../../shared/setup";
import { I18nProvider, translate } from "../../lib/i18n";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { fakeSetupApi, setupState } from "../../test-support/machine-setup";
import { MachineSetupSection } from "./MachineSetupSection";

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

const fake = fakeSetupApi(setupState("darwin"));
const openExternal = vi.fn(async () => {});
Object.assign(window as unknown as Record<string, unknown>, { omp: { setup: fake.api, system: { openExternal } } });

let root: Root | null = null;
async function mount(state: SetupState): Promise<void> {
	fake.current.state = state;
	root = createRoot(document.body as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<MachineSetupSection />
			</I18nProvider>,
		),
	);
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}
const row = (id: string) => document.body.querySelector(`[data-setup-item="${id}"]`) as HTMLElement | null;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useMachineSetupStore.getState().reset();
	for (const fn of Object.values(fake.api)) fn.mockClear();
	openExternal.mockClear();
});

describe("MachineSetupSection", () => {
	it("lists every item, a quiet notice for an unavailable optional item, and Retry for a failed one", async () => {
		await mount(
			setupState("darwin", {
				node: { phase: "unavailable", presence: { kind: "missing" }, manualUrl: "https://nodejs.org/en/download" },
				gh: {
					phase: "failed",
					presence: { kind: "missing" },
					method: "brew",
					command: "brew install gh",
					failure: { reason: "exit", exitCode: 1 },
					output: "Error: gh: no bottle available",
				},
			}),
		);

		const section = document.body.querySelector('[data-testid="machine-setup-settings"]');
		expect(section?.textContent).toContain(translate("machineSetup.settings.title"));
		expect(
			Array.from(document.body.querySelectorAll("[data-setup-item]")).map(el => el.getAttribute("data-setup-item")),
		).toEqual([...SETUP_ITEMS]);
		expect(row("bun")?.textContent).toContain(translate("machineSetup.required"));
		expect(row("git")?.textContent).toContain(translate("machineSetup.optional"));
		expect(row("bun")?.textContent).toContain("/usr/local/bin/bun");

		const node = row("node");
		expect(node?.getAttribute("data-phase")).toBe("unavailable");
		expect(node?.textContent).toContain(translate("machineSetup.purpose.node"));
		expect(node?.textContent).toContain(translate("machineSetup.unavailableHint", { name: "Node.js" }));
		expect(node?.querySelector('[data-testid="setup-retry"]')).toBeNull();
		await act(async () => (node?.querySelector("[data-inline-notice] button") as HTMLElement | null)?.click());
		expect(openExternal).toHaveBeenCalledWith("https://nodejs.org/en/download");

		const gh = row("gh");
		expect(gh?.textContent).toContain(translate("machineSetup.reason.exit", { code: 1 }));
		expect(gh?.textContent).toContain("brew install gh");
		expect(gh?.querySelector('[data-testid="setup-output-toggle"]')?.getAttribute("aria-expanded")).toBe("false");
		await act(async () => (gh?.querySelector('[data-testid="setup-retry"]') as HTMLElement | null)?.click());
		expect(fake.api.retry).toHaveBeenCalledWith("gh");
	});

	it("offers Cancel on the item that runs", async () => {
		await mount(setupState("darwin", { node: { phase: "running", presence: { kind: "missing" }, output: "" } }));
		await act(async () =>
			(row("node")?.querySelector('[data-testid="setup-cancel"]') as HTMLElement | null)?.click(),
		);
		expect(fake.api.cancel).toHaveBeenCalledTimes(1);
		expect(row("bun")?.querySelector('[data-testid="setup-cancel"]')).toBeNull();
	});

	it("shows a background install's place in its run and its download percent", async () => {
		await mount(
			setupState("darwin", {
				gh: {
					phase: "running",
					presence: { kind: "missing" },
					method: "archive",
					progress: { step: 1, steps: 2, startedAt: Date.now(), download: { received: 250, total: 1000 } },
				},
				node: { phase: "queued", presence: { kind: "missing" } },
			}),
		);
		expect(row("gh")?.textContent).toContain(translate("machineSetup.progress.step", { step: 1, steps: 2 }));
		expect(row("gh")?.textContent).toContain("25%");
		expect(row("gh")?.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("0.25");
		expect(row("node")?.querySelector("[role='progressbar']")).toBeNull();
	});

	it("is hidden where OMPdesk doesn't set the machine up", async () => {
		await mount(setupState("other"));
		expect(document.body.querySelector('[data-testid="machine-setup-settings"]')).toBeNull();
	});
});
