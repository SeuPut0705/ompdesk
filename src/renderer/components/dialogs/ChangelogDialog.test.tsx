/**
 * DOM smoke test for the changelog window: ui-store open/close wiring and
 * the bundled CHANGELOG.md rendering through the sanitized markdown pipeline.
 * Same linkedom harness as the other dialog tests (no jsdom in this repo).
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import changelogMarkdown from "../../../../CHANGELOG.md?raw";
import { I18nProvider, translate } from "../../lib/i18n";
import { WHATS_NEW_PREF } from "../../lib/whats-new";
import { useFirstRunStore } from "../../stores/first-run";
import { useSessionStore } from "../../stores/session";
import { useStarterGuideStore } from "../../stores/starter-guide";
import { useUiStore } from "../../stores/ui";
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

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window as unknown as Record<string, unknown>, { omp: { prefs, updater } });
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
	stored = {};
});

describe("ChangelogDialog", () => {
	it("stays hidden until the ui store opens it", async () => {
		await mount(<ChangelogDialog />);
		expect(firstRelease).not.toBe("");
		expect(document.body.textContent ?? "").not.toContain(firstRelease);
		await act(async () => {
			useUiStore.getState().openChangelog();
		});
		expect(document.body.textContent ?? "").toContain(firstRelease);
	});

	it("renders the bundled changelog as sanitized markdown under the window's one title", async () => {
		useUiStore.getState().openChangelog();
		await mount(<ChangelogDialog />);
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
		expect(document.body.textContent ?? "").toContain(firstRelease);
		await act(async () => {
			useUiStore.getState().closeChangelog();
		});
		// The modal lingers ~240ms for its exit animation before unmounting.
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 300));
		});
		expect(document.body.textContent ?? "").not.toContain(firstRelease);
	});
});

describe("WhatsNewNotice", () => {
	/** Let the notice's async prefs/version reads finish. */
	const settle = () =>
		act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});

	it("opens the new version's notes once after an update and marks them seen only once shown", async () => {
		expect(older).not.toBe("");
		stored[WHATS_NEW_PREF] = older;
		await mount(
			<>
				<WhatsNewNotice />
				<ChangelogDialog />
			</>,
		);
		await settle();
		// Nothing before the session is ready: first-run setup may still claim the window.
		expect(useUiStore.getState().changelogOpen).toBe(false);
		await act(async () => useSessionStore.setState({ status: "ready" }));
		await settle();
		const text = document.body.textContent ?? "";
		expect(text).toContain(translate("whatsNew.title", { version: latest }));
		// Only this release: the previous one's heading is not in the notice.
		expect(text).not.toContain(`[${older}]`);
		expect(stored[WHATS_NEW_PREF]).toBe(latest);
		await act(async () => {
			[...document.querySelectorAll("button")]
				.find(node => node.textContent?.trim() === translate("whatsNew.allChanges"))
				?.click();
		});
		expect(document.body.textContent ?? "").toContain(`[${older}]`);
	});

	it("waits while first-run setup or a tour covers the window", async () => {
		stored[WHATS_NEW_PREF] = older;
		useFirstRunStore.setState({ phase: "connect" });
		useSessionStore.setState({ status: "ready" });
		await mount(<WhatsNewNotice />);
		await settle();
		expect(useUiStore.getState().changelogOpen).toBe(false);
		await act(async () => {
			useFirstRunStore.getState().reset();
			useStarterGuideStore.getState().startTour("model");
		});
		await settle();
		expect(useUiStore.getState().changelogOpen).toBe(false);
		await act(async () => useStarterGuideStore.getState().endTour());
		await settle();
		expect(useUiStore.getState().changelogOpen).toBe(true);
	});

	it("records a first launch without showing anything", async () => {
		useSessionStore.setState({ status: "ready" });
		await mount(<WhatsNewNotice />);
		await settle();
		expect(useUiStore.getState().changelogOpen).toBe(false);
		expect(stored[WHATS_NEW_PREF]).toBe(latest);
	});
});
