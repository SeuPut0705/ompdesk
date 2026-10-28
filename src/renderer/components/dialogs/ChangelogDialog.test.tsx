/**
 * DOM smoke test for the changelog window: ui-store open/close wiring and
 * the bundled CHANGELOG.md rendering through the sanitized markdown pipeline.
 * The markdown is a lazy chunk (`loadChangelog`), so each step that shows it
 * first lets that import finish (`settle`).
 * Same linkedom harness as the other dialog tests (no jsdom in this repo).
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import changelogMarkdown from "../../../../CHANGELOG.md?raw";
import { I18nProvider, translate } from "../../lib/i18n";
import { loadChangelog, WHATS_NEW_PREF } from "../../lib/whats-new";
import { useFirstRunStore } from "../../stores/first-run";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { useSessionStore } from "../../stores/session";
import { useStarterGuideStore } from "../../stores/starter-guide";
import { useUiStore } from "../../stores/ui";
import { WHATS_NEW_AUTO_HIDE_MS, WhatsNewCard } from "../layout/WhatsNewCard";
import { ChangelogDialog, WhatsNewNotice } from "./ChangelogDialog";

// The first release heading of the bundled file (e.g. "[0.1.0] - Unreleased"),
// so the test follows the shipped changelog instead of pinning its wording.
const firstRelease = changelogMarkdown.match(/^## (.+)$/m)?.[1] ?? "";
const latest = firstRelease.match(/^\[([^\]]+)\]/)?.[1] ?? "";
const older = changelogMarkdown.match(/^## \[([^\]]+)\]/gm)?.[1]?.slice(4, -1) ?? "";

let stored: Record<string, unknown> = {};
const prefs = {
	get: vi.fn(async (key: string): Promise<unknown> => stored[key]),
	set: vi.fn(async (key: string, value: unknown): Promise<void> => {
		stored[key] = value;
	}),
};
const updater = { version: vi.fn(async () => latest) };
// The notes name repo paths (`src/main/…`): MarkdownRenderer probes each one with a
// one-byte `fs:read` before linking it (lib/markdown-path-link.ts). None exists here.
const fs = { read: vi.fn(async () => ({ ok: false, code: "not_found" })) };

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window as unknown as Record<string, unknown>, { omp: { prefs, updater, fs } });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

let container: InstanceType<typeof HTMLElement> | null = null;
let root: Root | null = null;

async function mount(ui: ReactElement): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(<I18nProvider>{ui}</I18nProvider>);
	});
}

/** Let the changelog import and the notice's async prefs/version reads finish. */
const settle = () =>
	act(async () => {
		await loadChangelog();
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	container = null;
	root = null;
	useUiStore.getState().closeChangelog();
	useSessionStore.setState({ status: "starting" });
	useFirstRunStore.getState().reset();
	useStarterGuideStore.getState().reset();
	useMachineSetupStore.getState().reset();
	useUiStore.getState().dismissWhatsNewCard();
	stored = {};
});

describe("ChangelogDialog", () => {
	// The first case pays for loading the Markdown renderer and the whole bundled CHANGELOG (about 1 s here, past 5 s
	// on a loaded CI shard as the changelog grows).
	it("stays hidden until the ui store opens it", { timeout: 30_000 }, async () => {
		await mount(<ChangelogDialog />);
		expect(firstRelease).not.toBe("");
		expect(document.body.textContent ?? "").not.toContain(firstRelease);
		await act(async () => {
			useUiStore.getState().openChangelog();
		});
		await settle();
		expect(document.body.textContent ?? "").toContain(firstRelease);
	});

	it("renders the bundled changelog as sanitized markdown under the window's one title", async () => {
		useUiStore.getState().openChangelog();
		await mount(<ChangelogDialog />);
		await settle();
		const text = document.body.textContent ?? "";
		// The help menu's item and the window share one name.
		expect(text).toContain("What's new");
		expect(text).toContain(firstRelease);
		// The markdown pipeline renders headings as elements, not literal "#".
		expect(document.querySelector("h2")).not.toBeNull();
		// The file's own "# Changelog" heading would repeat the window title.
		expect(text).not.toContain("Changelog");
	});

	it("closes back to an empty body", async () => {
		useUiStore.getState().openChangelog();
		await mount(<ChangelogDialog />);
		await settle();
		expect(document.body.textContent ?? "").toContain(firstRelease);
		// The modal lingers ~240ms for its exit animation before unmounting.
		vi.useFakeTimers();
		try {
			await act(async () => {
				useUiStore.getState().closeChangelog();
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(300);
			});
		} finally {
			vi.useRealTimers();
		}
		expect(document.body.textContent ?? "").not.toContain(firstRelease);
	});
});

describe("WhatsNewNotice", () => {
	const click = (label: string) =>
		act(async () => {
			[...document.querySelectorAll("button")]
				.find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label)
				?.click();
		});

	it("shows a quiet card, not the dialog, once after an update, and marks it seen once it is up", async () => {
		expect(older).not.toBe("");
		stored[WHATS_NEW_PREF] = older;
		await mount(
			<>
				<WhatsNewNotice />
				<WhatsNewCard />
				<ChangelogDialog />
			</>,
		);
		await settle();
		// Nothing before the session is ready: first-run setup may still claim the window.
		expect(useUiStore.getState().whatsNewCard).toBeNull();
		expect(stored[WHATS_NEW_PREF]).toBe(older);
		await act(async () => useSessionStore.setState({ status: "ready" }));
		await settle();
		const card = document.querySelector("[data-whats-new-card]");
		expect(card?.textContent).toContain(translate("whatsNew.cardTitle", { version: latest }));
		expect(card?.textContent).toContain(translate("whatsNew.details"));
		expect(document.querySelector("[data-whats-new-summary]")?.textContent?.length ?? 0).toBeGreaterThan(0);
		// No modal: the dialog stays closed until the card is opened.
		expect(useUiStore.getState().changelogOpen).toBe(false);
		expect(stored[WHATS_NEW_PREF]).toBe(latest);
		await click(translate("whatsNew.details"));
		expect(useUiStore.getState().changelogOpen).toBe(true);
		expect(useUiStore.getState().whatsNewCard).toBeNull();
		const text = document.body.textContent ?? "";
		expect(text).toContain(translate("whatsNew.title", { version: latest }));
		expect(text).not.toContain(`[${older}]`);
		await click(translate("whatsNew.allChanges"));
		expect(document.body.textContent ?? "").toContain(`[${older}]`);
	});

	it("lists every release since the last seen one when several were skipped", async () => {
		const versions = [...changelogMarkdown.matchAll(/^## \[([^\]]+)\]/gm)].map(match => match[1]);
		const oldest = versions[2];
		expect(oldest).toBeTruthy();
		stored[WHATS_NEW_PREF] = oldest;
		useSessionStore.setState({ status: "ready" });
		await mount(
			<>
				<WhatsNewNotice />
				<WhatsNewCard />
				<ChangelogDialog />
			</>,
		);
		await settle();
		// One card for the newest.
		expect(document.querySelectorAll("[data-whats-new-card]")).toHaveLength(1);
		expect(document.querySelector("[data-whats-new-card]")?.textContent).toContain(
			translate("whatsNew.cardTitle", { version: latest }),
		);
		await click(translate("whatsNew.details"));
		const text = document.body.textContent ?? "";
		expect(text).toContain(`[${versions[0]}]`);
		expect(text).toContain(`[${versions[1]}]`);
		expect(text).not.toContain(`[${oldest}]`);
	});

	it("dismisses with the close button or Esc and opens from a click on the card", async () => {
		useUiStore.getState().showWhatsNewCard(latest, older);
		await mount(<WhatsNewCard />);
		const live = document.querySelector('[role="status"][aria-live="polite"]');
		expect(live?.querySelector("[data-whats-new-card]")).not.toBeNull();
		await click(translate("common.close"));
		expect(document.querySelector("[data-whats-new-card]")).toBeNull();
		// The live region stays mounted so the next card is announced.
		expect(document.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();

		await act(async () => useUiStore.getState().showWhatsNewCard(latest, older));
		const card = document.querySelector("[data-whats-new-card]");
		expect(card?.getAttribute("tabindex")).toBe("0");
		await act(async () => {
			const keydown = Object.assign(new Event("keydown", { bubbles: true }), { key: "Escape" });
			card?.dispatchEvent(keydown);
		});
		expect(document.querySelector("[data-whats-new-card]")).toBeNull();

		await act(async () => useUiStore.getState().showWhatsNewCard(latest, older));
		await settle();
		expect(document.querySelector("[data-whats-new-summary]")?.textContent?.length ?? 0).toBeGreaterThan(0);
		await act(async () => {
			(document.querySelector("[data-whats-new-summary]") as HTMLElement | null)?.click();
		});
		expect(useUiStore.getState().changelogOpen).toBe(true);
		expect(useUiStore.getState().changelogVersion).toBe(latest);
	});

	it("hides itself after a minute of focused time", async () => {
		vi.useFakeTimers();
		try {
			useUiStore.getState().showWhatsNewCard(latest, older);
			await mount(<WhatsNewCard />);
			await act(async () => vi.advanceTimersByTimeAsync(WHATS_NEW_AUTO_HIDE_MS - 1000));
			expect(document.querySelector("[data-whats-new-card]")).not.toBeNull();
			await act(async () => vi.advanceTimersByTimeAsync(2000));
			expect(document.querySelector("[data-whats-new-card]")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits while the machine setup, first-run setup or a tour covers the window", async () => {
		stored[WHATS_NEW_PREF] = older;
		useFirstRunStore.setState({ phase: "connect" });
		useMachineSetupStore.getState().setTakeover(true);
		useSessionStore.setState({ status: "ready" });
		await mount(<WhatsNewNotice />);
		await settle();
		expect(useUiStore.getState().whatsNewCard).toBeNull();
		await act(async () => {
			useFirstRunStore.getState().reset();
			useStarterGuideStore.getState().startTour("model");
		});
		await settle();
		expect(useUiStore.getState().whatsNewCard).toBeNull();
		await act(async () => useStarterGuideStore.getState().endTour());
		await settle();
		expect(useUiStore.getState().whatsNewCard).toBeNull();
		await act(async () => useMachineSetupStore.getState().setTakeover(false));
		await settle();
		expect(useUiStore.getState().whatsNewCard?.version).toBe(latest);
		expect(useUiStore.getState().changelogOpen).toBe(false);
	});

	it("records a first launch without showing anything", async () => {
		useSessionStore.setState({ status: "ready" });
		await mount(<WhatsNewNotice />);
		await settle();
		expect(useUiStore.getState().changelogOpen).toBe(false);
		expect(useUiStore.getState().whatsNewCard).toBeNull();
		expect(stored[WHATS_NEW_PREF]).toBe(latest);
	});
});
