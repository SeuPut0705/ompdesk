/**
 * Settings › General › Conversation language: offers automatic, the curated
 * languages and "don't set"; names the detected device language on automatic;
 * saves the choice to prefs `replyLanguage` (main fans it out to open sessions).
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemInfo } from "../../../shared/ipc-types";
import { REPLY_LANGUAGE_CHOICES } from "../../../shared/reply-language";
import { I18nProvider, translate } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { ReplyLanguageRow } from "./ReplyLanguageRow";

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

const info: SystemInfo = {
	appVersion: "0.11.1",
	platform: "darwin",
	arch: "arm64",
	deviceLanguage: "ja",
	osRelease: "25.0.0",
	electron: "36.9.5",
	chrome: "134.0",
	node: "22.0.0",
};

let stored: unknown;
const prefs = {
	get: vi.fn(async (_key?: string): Promise<unknown> => stored),
	set: vi.fn(async (_key: string, value: unknown): Promise<void> => {
		stored = value;
	}),
};
const system = { info: vi.fn(async (): Promise<SystemInfo> => info) };
Object.assign(window as unknown as Record<string, unknown>, { omp: { prefs, system } });

const roots: Root[] = [];

async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ReplyLanguageRow />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
}

function field(): HTMLSelectElement {
	const select = document.body.querySelector("#setting-gui-replyLanguage select") as HTMLSelectElement | null;
	if (!select) throw new Error("conversation language select missing");
	return select;
}

/** Pick a value and drive the select's React onChange contract (linkedom's select.value is read-only). */
async function choose(value: string): Promise<void> {
	const record = field() as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void }) : undefined;
	if (!props?.onChange) throw new Error("select onChange not found");
	await act(async () => props.onChange?.({ target: { value }, currentTarget: { value } }));
}

function text(): string {
	return document.body.textContent ?? "";
}

beforeEach(() => {
	stored = undefined;
});

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useToastStore.setState({ toasts: [] });
	vi.clearAllMocks();
});

describe("ReplyLanguageRow", () => {
	it("defaults to automatic and names the detected device language", async () => {
		await mount();

		expect(prefs.get).toHaveBeenCalledWith("replyLanguage");
		const options = Array.from(field().querySelectorAll("option")).map(option => option.value);
		expect(options).toEqual(["auto", ...REPLY_LANGUAGE_CHOICES, "off"]);
		expect(field().value).toBe("auto");
		expect(field().disabled).toBe(false);
		expect(text()).toContain(translate("settings.gui.replyLanguage"));
		expect(text()).toContain(translate("settings.gui.replyLanguage.auto"));
		expect(text()).toContain(translate("settings.gui.replyLanguage.chineseTraditional"));
		expect(text()).toContain(translate("settings.gui.replyLanguage.off"));
		expect(text()).toContain(translate("settings.gui.replyLanguageDescAuto", { language: "Japanese" }));
	});

	it("shows a stored choice and saves a new one to prefs", async () => {
		stored = "German";
		await mount();
		expect(field().value).toBe("German");
		expect(text()).toContain(translate("settings.gui.replyLanguageDesc"));

		await choose("Korean");
		expect(prefs.set).toHaveBeenCalledWith("replyLanguage", "Korean");
		expect(field().value).toBe("Korean");

		await choose("off");
		expect(prefs.set).toHaveBeenLastCalledWith("replyLanguage", "off");
		expect(field().value).toBe("off");
		expect(text()).toContain(translate("settings.gui.replyLanguageDescOff"));
	});

	it("reads an unknown stored value as automatic and never saves a value outside the list", async () => {
		stored = "Klingon";
		await mount();
		expect(field().value).toBe("auto");

		await choose("Klingon");
		expect(prefs.set).not.toHaveBeenCalled();
	});

	it("keeps the previous choice and toasts when saving fails", async () => {
		prefs.set.mockRejectedValueOnce(new Error("disk full"));
		await mount();

		await choose("Spanish");
		expect(field().value).toBe("auto");
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toContain(translate("settings.saveFailed"));
	});

	it("leaves the detected name out when the device language is unknown", async () => {
		system.info.mockResolvedValueOnce({ ...info, deviceLanguage: null });
		await mount();
		expect(text()).toContain(translate("settings.gui.replyLanguageDesc"));
	});
});
