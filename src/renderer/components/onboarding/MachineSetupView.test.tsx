/**
 * Machine setup is shown, never driven: no install button anywhere, the running
 * item's exact command/location/output, Cancel while it runs, and honest end
 * states (failed with reason + manual steps + Retry, cancelled as a user stop,
 * all present as "Starting omp…"). Remote tabs never show this machine's setup.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupItemState, SetupState } from "../../../shared/setup";
import { formatElapsed } from "../../lib/format";
import { I18nProvider, translate } from "../../lib/i18n";
import { useFirstRunStore } from "../../stores/first-run";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { type SessionStore, useSessionStore } from "../../stores/session";
import {
	deleteSessionRuntime,
	SessionRuntimeProvider,
	sessionRuntimeStore,
} from "../../stores/session-runtime-context";
import { ensureTabRuntime } from "../../stores/tab-runtime";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { fakeSetupApi, setupState } from "../../test-support/machine-setup";
import { SidecarBanner } from "../layout/SidecarBanner";
import { FirstRunSetup, useFirstRunActive } from "./FirstRunSetup";
import { MachineSetupView } from "./MachineSetupView";
import { SetupTakeoverHost } from "./SetupTakeover";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};
// Reduced motion: the takeover unmounts at once instead of fading out.
Object.assign(window as unknown as Record<string, unknown>, { matchMedia: () => ({ matches: true }) });

const ompMissing = (platform: "darwin" | "win32" = "darwin"): SetupState =>
	setupState(platform, { omp: { phase: "idle", presence: { kind: "missing" } } }, { ompReady: false });

const running = setupState(
	"win32",
	{
		git: {
			phase: "running",
			presence: { kind: "missing" },
			method: "portable-git",
			command: "PortableGit-2.47.0-64-bit.7z.exe -o C:\\Users\\me\\AppData\\Local\\ompdesk\\git -y",
			location: "C:\\Users\\me\\AppData\\Local\\ompdesk\\git",
			prompt: "uac",
			output: "\x1b[32mExtracting\x1b[0m 42%",
		},
		omp: { phase: "queued", presence: { kind: "missing" } },
	},
	{ ompReady: false, requiredRunning: true },
);

const failed = setupState(
	"darwin",
	{
		omp: {
			phase: "failed",
			presence: { kind: "missing" },
			method: "bun-global",
			command: "bun install -g @oh-my-pi/pi-coding-agent",
			location: "/Users/me/.bun/bin/omp",
			failure: { reason: "exit", exitCode: 1, detail: "error: GET https://registry.npmjs.org 503" },
			output: "error: 503",
			manualCommands: ["bun install -g @oh-my-pi/pi-coding-agent"],
			manualUrl: "https://github.com/can1357/oh-my-pi",
		},
	},
	{ ompReady: false },
);

const fake = fakeSetupApi(ompMissing());
const openExternal = vi.fn(async () => {});
const restart = vi.fn(async () => {});
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { setup: fake.api, system: { openExternal }, sidecar: { restart } },
});

const text = () => document.body.textContent ?? "";
function button(name: string): HTMLButtonElement | undefined {
	return Array.from(document.body.querySelectorAll("button")).find(
		candidate => (candidate.textContent ?? "").trim() === name,
	) as HTMLButtonElement | undefined;
}
const query = (selector: string) => document.body.querySelector(selector) as HTMLElement | null;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

const roots: Root[] = [];
async function mount(element: ReactElement, state: SetupState): Promise<void> {
	fake.current.state = state;
	const root = createRoot(document.body as unknown as Element);
	await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
	await flush();
	roots.push(root);
}

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useMachineSetupStore.getState().reset();
	deleteSessionRuntime("tab-1");
	useFirstRunStore.getState().reset();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	for (const fn of Object.values(fake.api)) fn.mockClear();
	openExternal.mockClear();
});

describe("MachineSetupView", () => {
	it("shows the running item's command, location, prompt and collapsed output with Cancel, and no install button", async () => {
		await mount(<MachineSetupView />, running);

		const rows = Array.from(document.body.querySelectorAll("[data-setup-item]")).map(row => [
			row.getAttribute("data-setup-item"),
			row.getAttribute("data-phase"),
		]);
		// Windows: Bun → Git for Windows → omp, optional items left out.
		expect(rows).toEqual([
			["bun", "present"],
			["git", "running"],
			["omp", "queued"],
		]);
		expect(text()).toContain("PortableGit-2.47.0-64-bit.7z.exe");
		expect(text()).toContain("C:\\Users\\me\\AppData\\Local\\ompdesk\\git");
		expect(text()).toContain(translate("machineSetup.prompt.uac"));

		const toggle = query('[data-testid="setup-output-toggle"]');
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(text()).not.toContain("Extracting");
		await act(async () => toggle?.click());
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		expect(text()).toContain("Extracting 42%");
		expect(text()).not.toContain("\x1b[32m");

		// Streamed output arrives through onState.
		await act(async () =>
			fake.push({
				...running,
				items: running.items.map(item => (item.id === "git" ? { ...item, output: `${item.output}\nDone` } : item)),
			}),
		);
		expect(text()).toContain("Done");

		expect(query('[data-testid="setup-retry"]')).toBeNull();
		for (const candidate of document.body.querySelectorAll("button")) {
			expect(candidate.textContent ?? "").not.toMatch(/install/i);
		}
		await act(async () => query('[data-testid="setup-cancel"]')?.click());
		expect(fake.api.cancel).toHaveBeenCalledTimes(1);
	});

	it("shows the running step's place, elapsed time and download percent, indeterminate when no size is known", async () => {
		const now = 1_800_000_000_000;
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(now);
		try {
			const withProgress = (progress: SetupItemState["progress"]) =>
				setupState(
					"win32",
					{
						bun: { phase: "present" },
						git: { phase: "running", presence: { kind: "missing" }, method: "portable-git", progress },
						omp: { phase: "queued", presence: { kind: "missing" } },
					},
					{ ompReady: false, requiredRunning: true },
				);
			const mb = 1_048_576;
			await mount(
				<MachineSetupView />,
				withProgress({
					step: 1,
					steps: 2,
					startedAt: now - 65_000,
					download: { received: 30 * mb, total: 60 * mb },
				}),
			);
			const row = () => query('[data-setup-item="git"]');
			const bar = () => row()?.querySelector("[role='progressbar']");
			expect(row()?.textContent).toContain(translate("machineSetup.phase.downloading"));
			expect(row()?.textContent).toContain(translate("machineSetup.progress.step", { step: 1, steps: 2 }));
			expect(row()?.textContent).toContain(formatElapsed(65_000));
			expect(row()?.textContent).toContain(
				translate("machineSetup.progress.download", { received: "30.0 MB", total: "60.0 MB" }),
			);
			expect(row()?.textContent).toContain("50%");
			expect(bar()?.getAttribute("aria-valuenow")).toBe("0.5");
			expect(bar()?.getAttribute("aria-label")).toBe(translate("machineSetup.progress.label", { name: "Git" }));
			// Only the running item shows progress.
			expect(document.body.querySelectorAll("[role='progressbar']")).toHaveLength(1);

			// No announced size: bytes so far, no percent claimed.
			await act(async () =>
				fake.push(
					withProgress({
						step: 1,
						steps: 2,
						startedAt: now - 65_000,
						download: { received: 3 * mb, total: null },
					}),
				),
			);
			expect(row()?.textContent).toContain(translate("machineSetup.progress.downloaded", { received: "3.0 MB" }));
			expect(bar()?.hasAttribute("aria-valuenow")).toBe(false);
			expect(row()?.textContent).not.toContain("%");

			// The installer itself: indeterminate, still with its place and clock.
			await act(async () => fake.push(withProgress({ step: 1, steps: 2, startedAt: now - 2000, download: null })));
			expect(row()?.textContent).toContain(translate("machineSetup.phase.running"));
			expect(row()?.textContent).toContain(translate("machineSetup.progress.step", { step: 1, steps: 2 }));
			expect(row()?.textContent).toContain(formatElapsed(2000));
			expect(bar()?.hasAttribute("aria-valuenow")).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("explains a failure with its reason and manual steps, and Retry retries omp", async () => {
		await mount(<MachineSetupView />, failed);

		expect(query('[data-setup-item="omp"]')?.getAttribute("data-phase")).toBe("failed");
		expect(text()).toContain(translate("machineSetup.banner.failed", { name: "omp" }));
		expect(text()).toContain(translate("machineSetup.reason.exit", { code: 1 }));
		expect(text()).toContain("registry.npmjs.org 503");
		expect(text()).toContain(translate("machineSetup.manual.title"));
		expect(document.body.querySelector("[role='alert']")).not.toBeNull();
		expect(query('[data-testid="setup-cancel"]')).toBeNull();

		await act(async () => button(translate("machineSetup.manual.open"))?.click());
		expect(openExternal).toHaveBeenCalledWith("https://github.com/can1357/oh-my-pi");
		await act(async () => query('[data-testid="setup-retry"]')?.click());
		expect(fake.api.retry).toHaveBeenCalledWith("omp");
	});

	it("reports a cancel as the user's stop, not a failure", async () => {
		const cancelled = setupState(
			"darwin",
			{ omp: { phase: "cancelled", presence: { kind: "missing" }, command: "bun install -g x" } },
			{ ompReady: false },
		);
		await mount(<MachineSetupView />, cancelled);

		expect(text()).toContain(translate("machineSetup.banner.cancelled", { name: "omp" }));
		expect(text()).toContain(translate("machineSetup.cancelledHint"));
		expect(text()).not.toContain(translate("machineSetup.banner.failed", { name: "omp" }));
		expect(text()).not.toContain(translate("machineSetup.phase.failed"));
		expect(document.body.querySelector("[role='alert']")).toBeNull();
		expect(query('[data-testid="setup-retry"]')).not.toBeNull();
	});

	it("says omp is starting once every required item is present", async () => {
		await mount(<MachineSetupView />, setupState("darwin"));
		expect(text()).toContain(translate("machineSetup.starting"));
		expect(query('[data-testid="setup-retry"]')).toBeNull();
		expect(query('[data-testid="setup-cancel"]')).toBeNull();
	});

	it("keeps long paths inside narrow widths", async () => {
		await mount(<MachineSetupView />, running);
		const row = query('[data-setup-item="git"]');
		expect(row?.className).toContain("flex-wrap");
		expect(row?.className).toContain("min-w-0");
		const location = Array.from(document.body.querySelectorAll("dd")).find(
			dd => dd.textContent === "C:\\Users\\me\\AppData\\Local\\ompdesk\\git",
		);
		expect(location?.className).toContain("break-all");
	});
});

function ActiveProbe() {
	return <span data-active={String(useFirstRunActive())} />;
}

async function mountTab(element: ReactElement, state: SetupState, device?: string): Promise<SessionStore> {
	useTabsStore.setState({
		tabs: [{ id: "tab-1", cwd: "/p", status: "error", kind: "agent", unreadDone: false, device }],
		activeTabId: "tab-1",
	});
	const runtime = ensureTabRuntime("tab-1");
	const session = sessionRuntimeStore<SessionStore>("tab-1", "session");
	if (!session) throw new Error("no runtime session store");
	session.getState().setStatus("error", "/p");
	await mount(<SessionRuntimeProvider runtime={runtime}>{element}</SessionRuntimeProvider>, state);
	return session.getState();
}

describe("useFirstRunActive with machine setup", () => {
	it("is true for a local tab whose omp failed to start while omp is missing, and the takeover shows the install", async () => {
		await mountTab(
			<>
				<ActiveProbe />
				<FirstRunSetup />
				<SetupTakeoverHost />
			</>,
			ompMissing(),
		);
		expect(query("[data-active]")?.getAttribute("data-active")).toBe("true");
		// The install lives in the full-window screen, never in the first-run step list.
		expect(query("[data-first-run-step]")).toBeNull();
		expect(query('[data-testid="setup-takeover"] [data-testid="machine-setup"]')).not.toBeNull();
		expect(useMachineSetupStore.getState().takeover).toBe(true);
	});

	it("is false while the session is ready, and when omp is ready without an install this launch", async () => {
		const session = await mountTab(<ActiveProbe />, setupState("darwin"));
		expect(query("[data-active]")?.getAttribute("data-active")).toBe("false");
		await act(async () => session.setStatus("ready", "/p"));
		expect(query("[data-active]")?.getAttribute("data-active")).toBe("false");
	});

	it("keeps the takeover (as Starting omp…) after an install until the session is back", async () => {
		const session = await mountTab(<SetupTakeoverHost />, ompMissing());
		await act(async () => fake.push(setupState("darwin")));
		expect(text()).toContain(translate("machineSetup.starting"));
		await act(async () => session.setStatus("ready", "/p"));
		expect(query('[data-testid="machine-setup"]')).toBeNull();
		expect(useMachineSetupStore.getState().installSeen).toBe(false);
		expect(useMachineSetupStore.getState().takeover).toBe(false);
	});

	it("never takes over for an optional item that is installing in the background", async () => {
		await mountTab(
			<SetupTakeoverHost />,
			setupState("darwin", { gh: { phase: "running", presence: { kind: "missing" } } }, { ompReady: true }),
		);
		expect(query('[data-testid="setup-takeover"]')).toBeNull();
		expect(useMachineSetupStore.getState().takeover).toBe(false);
	});

	it("never shows this machine's setup for a remote tab", async () => {
		await mountTab(
			<>
				<ActiveProbe />
				<FirstRunSetup />
				<SidecarBanner />
				<SetupTakeoverHost />
			</>,
			ompMissing(),
			"host-b",
		);
		expect(query("[data-active]")?.getAttribute("data-active")).toBe("false");
		expect(query('[data-testid="setup-takeover"]')).toBeNull();
		expect(useMachineSetupStore.getState().takeover).toBe(false);
		expect(query('[data-testid="machine-setup"]')).toBeNull();
		expect(fake.api.getState).not.toHaveBeenCalled();
	});
});
