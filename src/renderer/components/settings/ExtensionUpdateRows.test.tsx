/**
 * Settings › Updates & about › This computer › Extensions: the switch is on by default (state's `enabled`) and
 * writes the `extensionAutoUpdate` pref; one row per marketplace, plugin, skill and MCP server shows its
 * versions, how it is kept current and the last result or the reason it is left alone; "Update now" names the
 * row by key and is off while it runs, when it is skipped or pinned.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionRow, ExtensionUpdateState } from "../../../shared/extension-update";
import { I18nProvider, translate } from "../../lib/i18n";
import { useExtensionUpdateStore } from "../../stores/extension-update";
import { ExtensionUpdateRows, extensionDomId, extensionStatusText } from "./ExtensionUpdateRows";

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

function extRow(partial: Partial<ExtensionRow> & Pick<ExtensionRow, "key" | "kind" | "name">): ExtensionRow {
	return {
		detail: "user",
		count: null,
		installed: "1.0.0",
		latest: null,
		method: "marketplace",
		skip: null,
		phase: "idle",
		checkedAt: null,
		last: null,
		...partial,
	};
}

function extState(rows: ExtensionRow[], partial: Partial<ExtensionUpdateState> = {}): ExtensionUpdateState {
	return { enabled: true, scheduled: true, rows, ...partial };
}

let listener: ((state: ExtensionUpdateState) => void) | null = null;
const current = { state: extState([]) };
const api = {
	getState: vi.fn(async () => current.state),
	now: vi.fn(async (_key?: string) => {}),
	onState: vi.fn((callback: (state: ExtensionUpdateState) => void) => {
		listener = callback;
		return () => {
			listener = null;
		};
	}),
};
const prefsSet = vi.fn(async (_key: string, _value: unknown) => {});
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { extensionUpdate: api, prefs: { get: async () => undefined, set: prefsSet } },
});

let root: Root | null = null;
async function mount(state: ExtensionUpdateState): Promise<void> {
	current.state = state;
	root = createRoot(document.body as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<ExtensionUpdateRows />
			</I18nProvider>,
		),
	);
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}
const push = (state: ExtensionUpdateState) =>
	act(async () => {
		listener?.(state);
	});
const toggle = () => document.body.querySelector("#setting-gui-extensionAutoUpdate [role='switch']") as HTMLElement;
const row = (key: string) => document.body.querySelector(`#setting-extension-${extensionDomId(key)}`) as HTMLElement;
const nowButton = (key: string) =>
	document.body.querySelector(`[data-testid='extension-update-now-${extensionDomId(key)}']`) as HTMLButtonElement;
const text = (kind: "meta" | "version" | "status", key: string) =>
	document.body.querySelector(`[data-testid='extension-${kind}-${extensionDomId(key)}']`)?.textContent;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useExtensionUpdateStore.getState().reset();
	for (const fn of [...Object.values(api), prefsSet]) fn.mockClear();
});

describe("ExtensionUpdateRows", () => {
	it("shows the switch on by default and writes the extensionAutoUpdate pref when it is turned off", async () => {
		await mount(extState([]));
		expect(translate("extensionUpdate.auto")).toBe("Update extensions automatically");
		expect(document.body.textContent).toContain(translate("extensionUpdate.auto"));
		expect(toggle().getAttribute("aria-checked")).toBe("true");
		await act(async () => toggle().click());
		expect(prefsSet).toHaveBeenCalledWith("extensionAutoUpdate", false);
		await push(extState([], { enabled: false }));
		expect(toggle().getAttribute("aria-checked")).toBe("false");
	});

	it("says so when nothing is set up", async () => {
		await mount(extState([]));
		expect(document.body.querySelector("[data-testid='extension-update-none']")?.textContent).toBe(
			translate("extensionUpdate.none"),
		);
	});

	it("shows a row per kind with versions, method and last result", async () => {
		const rows = [
			extRow({
				key: "marketplace:official",
				kind: "marketplace",
				name: "official",
				detail: null,
				installed: null,
				method: "catalog",
				last: { kind: "refreshed" },
			}),
			extRow({
				key: "plugin:tools@official:user",
				kind: "plugin",
				name: "tools@official",
				latest: "1.2.0",
				last: { kind: "updated", from: "1.0.0", to: "1.2.0" },
			}),
			extRow({
				key: "skill:@acme/review",
				kind: "skill",
				name: "@acme/review",
				method: "registry",
				latest: "1.0.0",
				last: { kind: "current" },
			}),
			extRow({
				key: "mcp:files",
				kind: "mcp",
				name: "files",
				detail: "files-mcp",
				method: "npm",
			}),
		];
		await mount(extState(rows));
		expect(document.body.querySelectorAll("[data-extension-row]").length).toBe(4);
		expect(row("plugin:tools@official:user").textContent).toContain(
			translate("extensionUpdate.method", { method: translate("extensionUpdate.method.marketplace") }),
		);
		expect(text("meta", "plugin:tools@official:user")).toBe(`${translate("extensionUpdate.kind.plugin")} · user`);
		expect(text("version", "plugin:tools@official:user")).toBe(
			`${translate("extensionUpdate.version.installed", { version: "1.0.0" })} · ${translate("extensionUpdate.version.latest", { version: "1.2.0" })}`,
		);
		expect(text("status", "plugin:tools@official:user")).toBe(
			translate("extensionUpdate.status.updatedFrom", { from: "1.0.0", to: "1.2.0" }),
		);
		expect(text("status", "marketplace:official")).toBe(translate("extensionUpdate.status.refreshed"));
		expect(text("version", "marketplace:official")).toBeUndefined();
		expect(text("status", "skill:@acme/review")).toBe(translate("extensionUpdate.status.current"));
		expect(text("meta", "mcp:files")).toBe(`${translate("extensionUpdate.kind.mcp")} · files-mcp`);
		expect(text("status", "mcp:files")).toBe(translate("extensionUpdate.status.notChecked"));
		expect(row("mcp:files").textContent).toContain(
			translate("extensionUpdate.method", { method: translate("extensionUpdate.method.npm") }),
		);
	});

	it("shows grouped skill rows with localized names and their counts", async () => {
		await mount(
			extState([
				extRow({
					key: "skill:plugin",
					kind: "skill",
					name: "plugin",
					detail: null,
					count: 7,
					installed: null,
					method: null,
					skip: "follows-plugin",
				}),
				extRow({
					key: "skill:local",
					kind: "skill",
					name: "local",
					detail: null,
					count: 3,
					installed: null,
					method: null,
					skip: "local",
				}),
			]),
		);
		expect(row("skill:plugin").textContent).toContain("Skills from plugins");
		expect(row("skill:local").textContent).toContain("Local skills");
		expect(text("meta", "skill:plugin")).toContain(translate("extensionUpdate.count", { count: 7 }));
		expect(text("status", "skill:local")).toBe(translate("extensionUpdate.skip.local"));
		expect(nowButton("skill:local").disabled).toBe(true);
	});

	it("shows a pinned row's newer version and offers no update for it", async () => {
		await mount(
			extState([
				extRow({
					key: "plugin:pinned:user",
					kind: "plugin",
					name: "pinned",
					method: "npm-plugin",
					installed: "1.0.0",
					latest: "1.4.0",
					skip: "pinned",
					last: { kind: "available", latest: "1.4.0" },
				}),
				extRow({
					key: "plugin:same:user",
					kind: "plugin",
					name: "same",
					installed: "2.0.0",
					latest: "2.0.0",
					skip: "pinned",
					last: { kind: "current" },
				}),
			]),
		);
		expect(text("status", "plugin:pinned:user")).toBe(
			translate("extensionUpdate.status.available", { installed: "1.0.0", latest: "1.4.0" }),
		);
		expect(text("status", "plugin:pinned:user")).toContain("1.4.0");
		expect(text("status", "plugin:same:user")).toBe(
			translate("extensionUpdate.status.pinned", { installed: "2.0.0" }),
		);
		expect(nowButton("plugin:pinned:user").disabled).toBe(true);
	});

	it("names a skipped row's reason, including the built-in REA server", async () => {
		await mount(
			extState([
				extRow({
					key: "mcp:rea",
					kind: "mcp",
					name: "rea",
					detail: null,
					installed: "0.9.0",
					method: null,
					skip: "builtin",
				}),
			]),
		);
		expect(text("status", "mcp:rea")).toBe(translate("extensionUpdate.skip.builtin"));
		expect(row("mcp:rea").textContent).toContain(translate("extensionUpdate.method.none"));
		expect(nowButton("mcp:rea").disabled).toBe(true);
	});

	it("asks main to update that row by key, and is off while it runs", async () => {
		const a = extRow({ key: "plugin:a@m:user", kind: "plugin", name: "a@m" });
		const b = extRow({ key: "plugin:b@m:user", kind: "plugin", name: "b@m" });
		await mount(extState([a, b]));
		expect(nowButton(b.key).getAttribute("aria-label")).toBe(translate("extensionUpdate.nowFor", { name: "b@m" }));
		await act(async () => nowButton(b.key).click());
		expect(api.now).toHaveBeenCalledWith("plugin:b@m:user");
		await push(extState([{ ...a, phase: "updating" }, b]));
		expect(nowButton(a.key).disabled).toBe(true);
		expect(text("status", a.key)).toBe(translate("extensionUpdate.status.updating"));
		expect(nowButton(b.key).disabled).toBe(false);
		await push(extState([{ ...a, phase: "checking" }]));
		expect(text("status", a.key)).toBe(translate("extensionUpdate.status.checking"));
	});

	it("keeps a failure's reason with its detail and says the next check retries", async () => {
		await mount(
			extState([
				extRow({
					key: "plugin:a@m:user",
					kind: "plugin",
					name: "a@m",
					last: { kind: "failed", failure: { reason: "install", detail: "exit 1 — EACCES" } },
				}),
			]),
		);
		expect(text("status", "plugin:a@m:user")).toBe(translate("extensionUpdate.failure.install"));
		const notice = document.body.querySelector("[data-inline-notice='warning']");
		expect(notice?.textContent).toContain(translate("extensionUpdate.retryNote"));
		expect(notice?.textContent).toContain("EACCES");
	});
});

describe("extensionStatusText", () => {
	const t = translate;
	const base = extRow({ key: "mcp:x", kind: "mcp", name: "x", method: "npm" });

	it("explains deferred updates by reason and a build that never checks on its own", () => {
		expect(
			extensionStatusText(
				t,
				{ ...base, last: { kind: "deferred", latest: "2.0.0", why: "running" } },
				{ scheduled: true },
			),
		).toBe(translate("extensionUpdate.status.deferred.running"));
		expect(
			extensionStatusText(
				t,
				{ ...base, last: { kind: "deferred", latest: null, why: "omp-busy" } },
				{ scheduled: true },
			),
		).toBe(translate("extensionUpdate.status.deferred.omp-busy"));
		expect(extensionStatusText(t, base, { scheduled: false })).toBe(translate("extensionUpdate.status.manualOnly"));
	});

	it("names every failure reason", () => {
		for (const reason of ["check", "install", "not-updated", "needs-approval", "cancelled"] as const) {
			expect(
				extensionStatusText(t, { ...base, last: { kind: "failed", failure: { reason } } }, { scheduled: true }),
			).toBe(translate(`extensionUpdate.failure.${reason}`));
		}
	});

	it("falls back to the plain pinned text when no version is known", () => {
		expect(
			extensionStatusText(t, { ...base, skip: "pinned", installed: null, detail: null }, { scheduled: true }),
		).toBe(translate("extensionUpdate.skip.pinned"));
	});
});
