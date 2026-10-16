/**
 * Settings › Updates & about › This computer › tool CLIs: the switch is on by default (state's `enabled`) and
 * writes the `cliAutoUpdate` pref; one row per detected CLI shows its installed and newest version, its update
 * method and the last result or the reason it is left alone; "Update now" names the tool by id and is off while
 * that tool runs or when it is skipped.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliToolState, CliUpdateState } from "../../../shared/cli-update";
import { I18nProvider, translate } from "../../lib/i18n";
import { useCliUpdateStore } from "../../stores/cli-update";
import { CliUpdateRows } from "./CliUpdateRows";

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

function tool(partial: Partial<CliToolState> & Pick<CliToolState, "id">): CliToolState {
	return {
		providers: ["openai-codex"],
		installed: "0.50.1",
		path: "/p/bin/codex",
		method: "npm",
		skip: null,
		phase: "idle",
		latest: null,
		checkedAt: null,
		last: null,
		...partial,
	};
}

function cliState(tools: CliToolState[], partial: Partial<CliUpdateState> = {}): CliUpdateState {
	return { enabled: true, scheduled: true, tools, ...partial };
}

let listener: ((state: CliUpdateState) => void) | null = null;
const current = { state: cliState([]) };
const api = {
	getState: vi.fn(async () => current.state),
	now: vi.fn(async (_id?: string) => {}),
	onState: vi.fn((callback: (state: CliUpdateState) => void) => {
		listener = callback;
		return () => {
			listener = null;
		};
	}),
};
const prefsSet = vi.fn(async (_key: string, _value: unknown) => {});
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { cliUpdate: api, prefs: { get: async () => undefined, set: prefsSet } },
});

let root: Root | null = null;
async function mount(state: CliUpdateState): Promise<void> {
	current.state = state;
	root = createRoot(document.body as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<CliUpdateRows />
			</I18nProvider>,
		),
	);
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}
const push = (state: CliUpdateState) =>
	act(async () => {
		listener?.(state);
	});
const toggle = () => document.body.querySelector("#setting-gui-cliAutoUpdate [role='switch']") as HTMLElement;
const row = (id: string) => document.body.querySelector(`#setting-cli-tool-${id}`) as HTMLElement;
const nowButton = (id: string) =>
	document.body.querySelector(`[data-testid='cli-update-now-${id}']`) as HTMLButtonElement;
const text = (testid: string) => document.body.querySelector(`[data-testid='${testid}']`)?.textContent;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useCliUpdateStore.getState().reset();
	for (const fn of [...Object.values(api), prefsSet]) fn.mockClear();
});

describe("CliUpdateRows", () => {
	it("shows the switch on by default and writes the cliAutoUpdate pref when it is turned off", async () => {
		await mount(cliState([]));
		expect(translate("cliUpdate.auto")).toBe("Update tool CLIs automatically");
		expect(document.body.textContent).toContain(translate("cliUpdate.auto"));
		expect(toggle().getAttribute("aria-checked")).toBe("true");
		await act(async () => toggle().click());
		expect(prefsSet).toHaveBeenCalledWith("cliAutoUpdate", false);
		await push(cliState([], { enabled: false }));
		expect(toggle().getAttribute("aria-checked")).toBe("false");
	});

	it("says so when none of the connected accounts' CLIs is installed", async () => {
		await mount(cliState([]));
		expect(text("cli-update-none")).toBe(translate("cliUpdate.none"));
	});

	it("shows one row per detected CLI with its versions, method and last result", async () => {
		await mount(
			cliState([
				tool({ id: "codex", latest: "0.51.0" }),
				tool({
					id: "claude",
					providers: ["anthropic"],
					installed: "2.0.1",
					latest: "2.0.1",
					method: "self",
					last: { kind: "current" },
				}),
				tool({
					id: "gh",
					providers: [],
					installed: "2.96.0",
					method: "brew",
					last: { kind: "updated", from: "2.90.0", to: "2.96.0" },
				}),
			]),
		);
		expect(document.body.querySelectorAll("[data-cli-tool]").length).toBe(3);
		expect(row("codex").textContent).toContain("Codex CLI");
		expect(row("codex").textContent).toContain(translate("cliUpdate.method", { method: "npm" }));
		expect(text("cli-version-codex")).toBe(
			`${translate("cliUpdate.version.installed", { version: "0.50.1" })} · ${translate("cliUpdate.version.latest", { version: "0.51.0" })}`,
		);
		expect(text("cli-status-codex")).toBe(translate("cliUpdate.status.notChecked"));
		expect(row("claude").textContent).toContain(
			translate("cliUpdate.method", { method: translate("cliUpdate.method.self") }),
		);
		expect(text("cli-status-claude")).toBe(translate("cliUpdate.status.current"));
		expect(text("cli-status-gh")).toBe(translate("cliUpdate.status.updatedFrom", { from: "2.90.0", to: "2.96.0" }));
		expect(row("gh").textContent).toContain(translate("cliUpdate.method", { method: "Homebrew" }));
	});

	it("names a skipped copy's reason and offers no update for it", async () => {
		await mount(
			cliState([
				tool({
					id: "codex",
					installed: "0.46.0",
					path: "/Applications/ChatGPT.app/Contents/Resources/codex",
					method: null,
					skip: "bundled",
				}),
			]),
		);
		expect(text("cli-status-codex")).toBe(translate("cliUpdate.skip.bundled"));
		expect(row("codex").textContent).toContain(translate("cliUpdate.method.none"));
		expect(nowButton("codex").disabled).toBe(true);
	});

	it("asks main to update that tool by id, and is off while it runs", async () => {
		await mount(cliState([tool({ id: "codex" }), tool({ id: "gemini", providers: ["google-gemini-cli"] })]));
		expect(nowButton("codex").getAttribute("aria-label")).toBe(translate("cliUpdate.nowFor", { name: "Codex CLI" }));
		await act(async () => nowButton("gemini").click());
		expect(api.now).toHaveBeenCalledWith("gemini");
		await push(
			cliState([tool({ id: "codex", phase: "updating" }), tool({ id: "gemini", providers: ["google-gemini-cli"] })]),
		);
		expect(nowButton("codex").disabled).toBe(true);
		expect(text("cli-status-codex")).toBe(translate("cliUpdate.status.updating"));
		expect(nowButton("gemini").disabled).toBe(false);
		await push(cliState([tool({ id: "codex", phase: "checking" })]));
		expect(text("cli-status-codex")).toBe(translate("cliUpdate.status.checking"));
	});

	it("keeps a failure's reason with the tool's own detail and says the next check retries", async () => {
		await mount(
			cliState([
				tool({
					id: "codex",
					last: { kind: "failed", failure: { reason: "install", detail: "exit 1 — EACCES: permission denied" } },
				}),
			]),
		);
		expect(text("cli-status-codex")).toBe(translate("cliUpdate.failure.install"));
		const notice = document.body.querySelector("[data-inline-notice='warning']");
		expect(notice?.textContent).toContain(translate("cliUpdate.retryNote"));
		expect(notice?.textContent).toContain("EACCES: permission denied");
	});

	it("explains a deferred update and a build that never checks on its own", async () => {
		await mount(cliState([tool({ id: "codex", last: { kind: "deferred", latest: "0.51.0" } })]));
		expect(text("cli-status-codex")).toBe(translate("cliUpdate.status.deferred", { latest: "0.51.0" }));
		await push(cliState([tool({ id: "codex" })], { scheduled: false }));
		expect(text("cli-status-codex")).toBe(translate("cliUpdate.status.manualOnly"));
		expect(nowButton("codex").disabled).toBe(false);
	});
});
