/**
 * Settings › General › Profile: how the agent addresses the user and their
 * development experience, stored together as prefs `userProfile` (main fans a
 * change out to open sessions, from their next turn).
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPERIENCE_LEVELS } from "../../../../resources/gui-bridge/user-profile-contracts";
import { I18nProvider, translate } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { ProfileSection } from "./ProfileSection";

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

let stored: unknown;
let failSet = false;
/** While set, every write waits for it to resolve (a slow prefs disk). */
let gate: Promise<void> | undefined;
const prefs = {
	get: vi.fn(async (_key?: string): Promise<unknown> => stored),
	set: vi.fn(async (_key: string, value: unknown): Promise<void> => {
		await gate;
		if (failSet) throw new Error("disk full");
		stored = value;
	}),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { prefs } });

const roots: Root[] = [];

async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ProfileSection />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
}

function nameInput(): HTMLInputElement {
	const input = document.body.querySelector("#setting-gui-profileName input") as HTMLInputElement | null;
	if (!input) throw new Error("name input missing");
	return input;
}

function experienceSelect(): HTMLSelectElement {
	const select = document.body.querySelector("#setting-gui-profileExperience select") as HTMLSelectElement | null;
	if (!select) throw new Error("experience select missing");
	return select;
}

function reactProps(element: object): Record<string, (event: object) => void> {
	const record = element as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("react props not found");
	return record[key] as Record<string, (event: object) => void>;
}

async function typeName(value: string): Promise<void> {
	await act(async () => reactProps(nameInput()).onChange({ target: { value }, currentTarget: { value } }));
	// The blur handler of the re-rendered input sees the draft.
	await act(async () => reactProps(nameInput()).onBlur({ target: nameInput(), currentTarget: nameInput() }));
}

async function chooseExperience(value: string): Promise<void> {
	await act(async () => reactProps(experienceSelect()).onChange({ target: { value }, currentTarget: { value } }));
}

function text(): string {
	return document.body.textContent ?? "";
}

beforeEach(() => {
	stored = undefined;
	failSet = false;
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

describe("ProfileSection", () => {
	it("shows an empty profile with every experience level and a not-set choice", async () => {
		await mount();
		expect(prefs.get).toHaveBeenCalledWith("userProfile");
		expect(text()).toContain(translate("settings.general.profile"));
		expect(text()).toContain(translate("settings.gui.profileName"));
		expect(text()).toContain(translate("settings.gui.profileExperience"));
		expect(nameInput().value).toBe("");
		const options = Array.from(experienceSelect().querySelectorAll("option")).map(option => option.value);
		expect(options).toEqual(["", ...EXPERIENCE_LEVELS]);
		expect(experienceSelect().value).toBe("");
		expect(text()).toContain(translate("settings.gui.profileExperience.vibe-coder"));
	});

	it("saves the name and the level together, keeping the other field", async () => {
		stored = { name: "", experience: "expert" };
		await mount();
		expect(experienceSelect().value).toBe("expert");
		await typeName("  Sam ");
		expect(prefs.set).toHaveBeenLastCalledWith("userProfile", { name: "Sam", experience: "expert" });
		await chooseExperience("beginner");
		expect(prefs.set).toHaveBeenLastCalledWith("userProfile", { name: "Sam", experience: "beginner" });
		await chooseExperience("");
		expect(prefs.set).toHaveBeenLastCalledWith("userProfile", { name: "Sam", experience: null });
	});

	it("does not save an unchanged name or one too long to be a form of address", async () => {
		stored = { name: "Sam", experience: null };
		await mount();
		expect(nameInput().value).toBe("Sam");
		await typeName("Sam ");
		expect(prefs.set).not.toHaveBeenCalled();
		await typeName("x".repeat(65));
		expect(prefs.set).not.toHaveBeenCalled();
		expect(text()).toContain(translate("settings.gui.profileNameTooLong", { max: 64 }));
	});

	it("reads a malformed stored value as empty and reports a failed save", async () => {
		stored = { name: 3, experience: "wizard" };
		await mount();
		expect(nameInput().value).toBe("");
		expect(experienceSelect().value).toBe("");
		failSet = true;
		await chooseExperience("junior");
		expect(experienceSelect().value).toBe("");
		expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
	});
});

describe("ProfileSection while a save is pending", () => {
	it("builds a level change on the name still being saved", async () => {
		await mount();
		const slow = Promise.withResolvers<void>();
		gate = slow.promise;
		await typeName("Sam");
		expect(nameInput().value).toBe("Sam");
		await chooseExperience("junior");
		expect(prefs.set).toHaveBeenLastCalledWith("userProfile", { name: "Sam", experience: "junior" });
		await act(async () => {
			slow.resolve();
			gate = undefined;
			await Promise.resolve();
		});
		expect(stored).toEqual({ name: "Sam", experience: "junior" });
	});
});
