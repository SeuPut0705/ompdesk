/**
 * Settings › Bot: the owner's action rules (pref `botRules`). The defaults show while nothing is stored, a behavior
 * change, an added, an edited and a deleted rule are each written whole to the pref before the list shows them, and a
 * default rule keeps its English stored text while the list shows it translated.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOT_RULES_PREF, type BotRule, DEFAULT_BOT_RULES } from "../../../shared/bot-rules";
import { I18nProvider } from "../../lib/i18n";
import { en } from "../../locales/en";
import { ko } from "../../locales/ko";
import { BotRulesSection } from "./BotRulesSection";
import { resolveSettingsTarget, SECTION_SCOPE, SETTINGS_NAV, SETTINGS_SECTION_IDS } from "./settings-catalog";

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

let stored: Record<string, unknown> = {};
let failGet = false;
let failSet = false;
let changedListener: ((event: { key: string }) => void) | null = null;
const get = vi.fn(async (key?: string) => {
	if (failGet) throw new Error("prefs unreadable");
	return key === undefined ? stored : stored[key];
});
const set = vi.fn(async (key: string, value: unknown) => {
	if (failSet) throw new Error("disk full");
	stored[key] = value;
});
Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		prefs: {
			get,
			set,
			onChanged: (callback: (event: { key: string }) => void) => {
				changedListener = callback;
				return () => {
					changedListener = null;
				};
			},
		},
	},
});

const roots: Root[] = [];
async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<BotRulesSection />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
}

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.innerHTML = "";
	stored = {};
	failGet = false;
	failSet = false;
	changedListener = null;
	get.mockClear();
	set.mockClear();
});

function reactProps(element: object): Record<string, (event: object) => void> {
	const record = element as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("react props not found");
	return record[key] as Record<string, (event: object) => void>;
}

async function click(element: object | null): Promise<void> {
	if (!element) throw new Error("click: element missing");
	await act(async () => reactProps(element).onClick?.({ preventDefault() {}, stopPropagation() {} }));
	await act(async () => {
		await Promise.resolve();
	});
}

function button(label: string): object | null {
	return (
		[...document.body.querySelectorAll("button")].find(
			item => item.getAttribute("aria-label") === label || (item.textContent ?? "").trim() === label,
		) ?? null
	);
}

async function choose(select: Element | null, value: string): Promise<void> {
	if (!select) throw new Error("choose: select missing");
	await act(async () => reactProps(select).onChange({ target: { value }, currentTarget: { value } }));
	await act(async () => {
		await Promise.resolve();
	});
}

async function type(label: string, value: string): Promise<void> {
	const field = [...document.body.querySelectorAll("label")].find(item => (item.textContent ?? "").trim() === label);
	const id = field?.getAttribute("for");
	const control = id ? document.body.querySelector(`[id="${id}"]`) : null;
	if (!control) throw new Error(`field "${label}" missing`);
	await act(async () => reactProps(control).onChange({ target: { value }, currentTarget: { value } }));
}

async function submitDialog(): Promise<void> {
	await act(async () =>
		reactProps(document.body.querySelector("[data-bot-rule-form]") as object).onSubmit({ preventDefault() {} }),
	);
	await act(async () => {
		await Promise.resolve();
	});
}

async function menuItem(rule: string, item: string): Promise<void> {
	await act(async () => (button(`Actions for ${rule}`) as HTMLButtonElement).click());
	const found = [...document.body.querySelectorAll('[role="menuitem"]')].find(
		node => (node.textContent ?? "").trim() === item,
	) as HTMLElement | undefined;
	await act(async () => found?.click());
}

const behaviorSelect = (id: string) => document.body.querySelector(`[data-bot-rule-behavior="${id}"]`);
const actionText = (id: string) => document.body.querySelector(`[data-bot-rule-action="${id}"]`)?.textContent;
const lastWrite = (): BotRule[] => {
	const call = set.mock.calls.at(-1);
	expect(call?.[0]).toBe(BOT_RULES_PREF);
	return call?.[1] as BotRule[];
};

describe("BotRulesSection", () => {
	it("shows the default rules with their behavior while nothing is stored", async () => {
		await mount();
		expect(document.body.querySelectorAll("[data-bot-rule-action]")).toHaveLength(DEFAULT_BOT_RULES.length);
		expect(actionText("deploy")).toBe("Deploy or release");
		expect((behaviorSelect("deploy") as HTMLSelectElement).value).toBe("ask");
		expect((behaviorSelect("push") as HTMLSelectElement).value).toBe("preapproved");
		expect((behaviorSelect("edits") as HTMLSelectElement).value).toBe("auto");
		const labels = [...(behaviorSelect("deploy")?.querySelectorAll("option") ?? [])].map(item => item.textContent);
		expect(labels).toEqual(["Without asking", "Only if pre-approved", "Ask first", "Hand off to me"]);
		expect(set).not.toHaveBeenCalled();
	});

	it("shows the stored list as it is, dropping what cannot be read", async () => {
		stored[BOT_RULES_PREF] = [
			{ id: "a", action: "Update dependencies", behavior: "handoff" },
			{ id: "b", action: "", behavior: "auto" },
		];
		await mount();
		expect(document.body.querySelectorAll("[data-bot-rule-action]")).toHaveLength(1);
		expect(actionText("a")).toBe("Update dependencies");
		expect((behaviorSelect("a") as HTMLSelectElement).value).toBe("handoff");
	});

	it("writes the whole list when a behavior changes, then shows it", async () => {
		await mount();
		await choose(behaviorSelect("edits"), "handoff");
		const written = lastWrite();
		expect(written).toHaveLength(DEFAULT_BOT_RULES.length);
		expect(written.find(rule => rule.id === "edits")).toEqual({
			id: "edits",
			action: "Edit code",
			behavior: "handoff",
		});
		expect(written.find(rule => rule.id === "deploy")).toEqual(DEFAULT_BOT_RULES[0]);
		expect((behaviorSelect("edits") as HTMLSelectElement).value).toBe("handoff");
	});

	it("starts a second quick change from the first one's result", async () => {
		await mount();
		await act(async () => {
			reactProps(behaviorSelect("edits") as object).onChange({
				target: { value: "ask" },
				currentTarget: { value: "ask" },
			});
			reactProps(behaviorSelect("tests") as object).onChange({
				target: { value: "ask" },
				currentTarget: { value: "ask" },
			});
		});
		await act(async () => {
			await Promise.resolve();
		});
		const written = lastWrite();
		expect(written.find(rule => rule.id === "edits")?.behavior).toBe("ask");
		expect(written.find(rule => rule.id === "tests")?.behavior).toBe("ask");
	});

	it("keeps the list when the write fails", async () => {
		await mount();
		failSet = true;
		await choose(behaviorSelect("edits"), "handoff");
		expect(set).toHaveBeenCalledTimes(1);
		expect((behaviorSelect("edits") as HTMLSelectElement).value).toBe("auto");
	});

	it("adds a rule from the dialog once its action is described", async () => {
		await mount();
		await click(document.body.querySelector("[data-bot-rule-new]"));
		await submitDialog();
		expect(document.body.textContent).toContain("Describe the action.");
		expect(set).not.toHaveBeenCalled();

		await type("Action", "  Update   dependencies ");
		await choose(document.body.querySelector('[role="dialog"] select'), "preapproved");
		await submitDialog();
		const written = lastWrite();
		expect(written).toHaveLength(DEFAULT_BOT_RULES.length + 1);
		const added = written.at(-1);
		expect(added).toMatchObject({ action: "Update dependencies", behavior: "preapproved" });
		expect(added?.id).toMatch(/^rule-/);
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();
		expect(actionText(added?.id ?? "")).toBe("Update dependencies");
	});

	it("keeps a default rule's stored text when only its behavior is edited, and takes new words as the owner's", async () => {
		await mount();
		await menuItem("Deploy or release", "Edit");
		const field = [...document.body.querySelectorAll("label")].find(
			item => (item.textContent ?? "").trim() === "Action",
		);
		const input = document.body.querySelector(`[id="${field?.getAttribute("for")}"]`) as HTMLInputElement;
		expect(input.getAttribute("value")).toBe("Deploy or release");
		await choose(document.body.querySelector('[role="dialog"] select'), "handoff");
		await submitDialog();
		expect(lastWrite().find(rule => rule.id === "deploy")).toEqual({
			id: "deploy",
			action: "Deploy or release",
			behavior: "handoff",
		});

		await menuItem("Deploy or release", "Edit");
		await type("Action", "Ship to production");
		await submitDialog();
		expect(lastWrite().find(rule => rule.id === "deploy")).toEqual({
			id: "deploy",
			action: "Ship to production",
			behavior: "handoff",
		});
		expect(actionText("deploy")).toBe("Ship to production");
	});

	it("deletes a rule after a confirmation, and offers the defaults back once none is left", async () => {
		await mount();
		await menuItem("Force-push", "Delete");
		expect(document.body.textContent).toContain("Delete this rule?");
		await click(
			[...document.body.querySelectorAll('[role="dialog"] button')].find(
				item => (item.textContent ?? "").trim() === "Delete",
			) ?? null,
		);
		expect(lastWrite().some(rule => rule.id === "force-push")).toBe(false);
		expect(actionText("force-push")).toBeUndefined();

		stored[BOT_RULES_PREF] = [];
		await act(async () => changedListener?.({ key: BOT_RULES_PREF }));
		await act(async () => {
			await Promise.resolve();
		});
		expect(document.body.textContent).toContain("No rules. Add one, or restore the defaults.");
		await click(document.body.querySelector("[data-bot-rules-restore]"));
		expect(lastWrite()).toEqual(DEFAULT_BOT_RULES);
		expect(actionText("deploy")).toBe("Deploy or release");
	});

	it("follows a change another window wrote", async () => {
		await mount();
		stored[BOT_RULES_PREF] = [{ id: "a", action: "Update dependencies", behavior: "ask" }];
		await act(async () => changedListener?.({ key: "other" }));
		expect(actionText("a")).toBeUndefined();
		await act(async () => changedListener?.({ key: BOT_RULES_PREF }));
		await act(async () => {
			await Promise.resolve();
		});
		expect(actionText("a")).toBe("Update dependencies");
	});

	it("offers a retry when the pref cannot be read, and never shows defaults over data it did not see", async () => {
		failGet = true;
		await mount();
		expect(document.body.textContent).toContain("Couldn't load the bot's rules");
		expect(document.body.querySelector("[data-bot-rules]")).toBeNull();
		failGet = false;
		await click(button("Retry"));
		expect(document.body.querySelectorAll("[data-bot-rule-action]")).toHaveLength(DEFAULT_BOT_RULES.length);
	});
});

describe("the Bot section's place and words", () => {
	it("sits in the Agent group after Permissions, is this device's own, and deep links", () => {
		const agent = SETTINGS_NAV.find(group => group.id === "agent")?.items ?? [];
		expect(agent.indexOf("bot")).toBe(agent.indexOf("permissions") + 1);
		expect(SETTINGS_SECTION_IDS).toContain("bot");
		expect(SECTION_SCOPE.bot).toBe("app");
		expect(resolveSettingsTarget("bot")).toEqual({ section: "bot", sub: undefined });
	});

	it("names every default rule in both languages, English matching the stored text", () => {
		for (const rule of DEFAULT_BOT_RULES) {
			expect(en[`botRules.default.${rule.id}`], rule.id).toBe(rule.action);
			expect(ko[`botRules.default.${rule.id}`], rule.id).toBeTruthy();
		}
		expect(en["settings.section.bot"]).toBe("Bot");
		expect(ko["settings.section.bot"]).toBe("봇");
		expect([
			ko["botRules.behavior.auto"],
			ko["botRules.behavior.preapproved"],
			ko["botRules.behavior.ask"],
			ko["botRules.behavior.handoff"],
		]).toEqual(["묻지 않고", "미리 승인했을 때만", "묻고 나서", "나에게 넘기기"]);
	});
});
