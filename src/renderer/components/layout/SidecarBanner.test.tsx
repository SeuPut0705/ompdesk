/**
 * SidecarBanner contract: the crash loop is reported as progress (amber,
 * "attempt N/M" from main's structured restart field, never by parsing English),
 * an exhausted loop as an error, and the close button actually hides the banner
 * for the diagnostic it was clicked on.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { type SessionStore, useSessionStore } from "../../stores/session";
import {
	SessionRuntimeProvider,
	sessionRuntimeStore,
	setFocusedSessionRuntime,
} from "../../stores/session-runtime-context";
import { ensureTabRuntime } from "../../stores/tab-runtime";
import { useTabsStore } from "../../stores/tabs";
import { SidecarBanner } from "./SidecarBanner";

const { document, window, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const restart = vi.fn(() => Promise.resolve());
Object.assign(window, { omp: { sidecar: { restart } } });

interface TestElement {
	textContent: string | null;
	className: string;
	click: () => void;
	remove: () => void;
	querySelectorAll: (selector: string) => TestElement[];
	querySelector: (selector: string) => TestElement | null;
}

let container: TestElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

async function click(index: number): Promise<void> {
	const button = container.querySelectorAll("button")[index] as unknown as TestElement;
	await act(async () => {
		button.click();
	});
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	restart.mockClear();
});

describe("SidecarBanner", () => {
	it("keeps diagnostics, dismissal and restart actions attached to each pane", async () => {
		const first = ensureTabRuntime("pane-a");
		const second = ensureTabRuntime("pane-b");
		const a = sessionRuntimeStore<SessionStore>("pane-a", "session")!;
		const b = sessionRuntimeStore<SessionStore>("pane-b", "session")!;
		a.getState().setStatus("error", "/a");
		a.getState().setSidecarError("Pane A failed");
		b.getState().setStatus("error", "/b");
		b.getState().setSidecarError("Pane B failed");
		setFocusedSessionRuntime("pane-a");
		await mount(
			<>
				<SessionRuntimeProvider runtime={first}>
					<div data-pane="a">
						<SidecarBanner />
					</div>
				</SessionRuntimeProvider>
				<SessionRuntimeProvider runtime={second}>
					<div data-pane="b">
						<SidecarBanner />
					</div>
				</SessionRuntimeProvider>
			</>,
		);
		expect(container.querySelector('[data-pane="a"]')?.textContent).toContain("Pane A failed");
		expect(container.querySelector('[data-pane="b"]')?.textContent).toContain("Pane B failed");
		await act(async () => container.querySelector('[data-pane="a"]')?.querySelectorAll("button")[1]?.click());
		expect(a.getState().sidecarDismissed).toBe(true);
		expect(b.getState().sidecarDismissed).toBe(false);
		await act(async () => container.querySelector('[data-pane="b"]')?.querySelectorAll("button")[0]?.click());
		expect(restart).toHaveBeenCalledWith({ tabId: "pane-b" });
	});

	it("reports an in-progress restart attempt instead of hiding it", async () => {
		useSessionStore.getState().setStatus("restarting", "/tmp/project");
		useSessionStore.getState().setSidecarError("Exit code 3 — dyld: Library not loaded", {
			attempt: 2,
			maxAttempts: 3,
		});
		await mount(<SidecarBanner />);

		expect(container.textContent).toContain(translate("sidecar.restartingTitle"));
		expect(container.textContent).toContain("Restart attempt 2/3");
		expect(container.textContent).toContain("Exit code 3 — dyld: Library not loaded");
		// Restart progress is a polite status announcement, not a failure alert.
		expect(container.querySelector("[role='status']")).not.toBeNull();
		expect(container.querySelector("[role='alert']")).toBeNull();
		expect(container.textContent).not.toContain(translate("sidecar.title"));
	});

	it("marks an exhausted crash loop as a failure with the last reason", async () => {
		useSessionStore.getState().setStatus("error", "/tmp/project");
		useSessionStore.getState().setSidecarError("Exit code 1 — omp: command not found", {
			attempt: 3,
			maxAttempts: 3,
		});
		await mount(<SidecarBanner />);

		expect(container.textContent).toContain(translate("sidecar.title"));
		expect(container.textContent).toContain("Gave up after 3 restart attempts");
		expect(container.textContent).toContain("omp: command not found");
		expect(container.querySelector("[role='alert']")).not.toBeNull();
	});

	it("hides the banner on close even while the status itself is the error", async () => {
		useSessionStore.getState().setStatus("error", "/tmp/project");
		useSessionStore.getState().setSidecarError("Exit code 1", null);
		await mount(<SidecarBanner />);
		expect(container.textContent).toContain(translate("sidecar.title"));

		// Close is the second button (the first is Restart).
		await click(1);
		expect(container.textContent).toBe("");
	});

	it("shows the next diagnostic after a dismissal", async () => {
		useSessionStore.getState().setStatus("restarting", "/tmp/project");
		useSessionStore.getState().setSidecarError("Exit code 3", { attempt: 1, maxAttempts: 3 });
		await mount(<SidecarBanner />);
		await click(1);
		expect(container.textContent).toBe("");

		await act(async () => {
			useSessionStore.getState().setSidecarError("Exit code 4", { attempt: 2, maxAttempts: 3 });
		});
		expect(container.textContent).toContain("Restart attempt 2/3");
		expect(container.textContent).toContain("Exit code 4");
	});

	it("stays out of the way while the agent is healthy", async () => {
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(<SidecarBanner />);
		expect(container.textContent).toBe("");
	});
});
