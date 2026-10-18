/**
 * The worktree branch prefix field saves only a prefix git accepts, on blur,
 * and shows the branch a new worktree tab would get.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { WorktreeBranchPrefixRow } from "./WorktreeBranchPrefixRow";

const { document, window, Event, HTMLElement, HTMLInputElement, Element, Node } =
	parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	HTMLInputElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const prefs = new Map<string, unknown>();
const set = vi.fn(async (key: string, value: unknown) => {
	prefs.set(key, value);
});
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { prefs: { get: async (key: string) => prefs.get(key), set } },
});

let root: Root | null = null;

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	prefs.clear();
	set.mockClear();
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

async function mount(): Promise<HTMLInputElement> {
	root = createRoot(document.body as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<WorktreeBranchPrefixRow />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return document.querySelector("input") as unknown as HTMLInputElement;
}

/** linkedom fires no React synthetic events, so the test calls the field's own handlers. */
function reactProps(input: HTMLInputElement): { onChange?: (event: object) => void; onBlur?: () => void } {
	const record = input as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	return key ? (record[key] as { onChange?: (event: object) => void; onBlur?: () => void }) : {};
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
	Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
	await act(async () => reactProps(input).onChange?.({ target: input, currentTarget: input }));
}

async function blur(input: HTMLInputElement): Promise<void> {
	await act(async () => reactProps(input).onBlur?.());
}

describe("WorktreeBranchPrefixRow", () => {
	it("shows the stored prefix in the example and saves a valid change on blur", async () => {
		prefs.set("worktreeBranchPrefix", "team/");
		const input = await mount();
		expect(input.value).toBe("team/");
		expect(document.body.textContent).toContain(
			translate("settings.worktreeBranchPrefix.example", { branch: "team/fix-login" }),
		);

		await type(input, "alice/");
		await blur(input);
		expect(set).toHaveBeenCalledWith("worktreeBranchPrefix", "alice/");
	});

	it("refuses a prefix git would reject and keeps the stored one", async () => {
		const input = await mount();
		expect(document.body.textContent).toContain(
			translate("settings.worktreeBranchPrefix.example", { branch: "omp/gui/fix-login" }),
		);
		await type(input, "../evil");
		await blur(input);
		expect(document.body.textContent).toContain(translate("settings.worktreeBranchPrefix.invalid"));
		expect(set).not.toHaveBeenCalled();
		expect(input.getAttribute("aria-invalid")).toBe("true");
	});

	it("saves on Enter, and Esc puts the stored prefix back", async () => {
		const input = await mount();
		const key = (name: string) => {
			const record = input as unknown as Record<string, unknown>;
			const props = Object.getOwnPropertyNames(record).find(prop => prop.startsWith("__reactProps$"));
			const handlers = props ? (record[props] as { onKeyDown?: (event: object) => void }) : {};
			return act(async () => handlers.onKeyDown?.({ key: name }));
		};
		await type(input, "alice/");
		await key("Enter");
		expect(set).toHaveBeenCalledWith("worktreeBranchPrefix", "alice/");
		await type(input, "bob/");
		await key("Escape");
		expect(input.value).toBe("alice/");
		expect(input.getAttribute("aria-invalid")).toBeNull();
	});

	it("does not save on the Enter that commits a Hangul composition", async () => {
		const input = await mount();
		const press = (event: object) => {
			const record = input as unknown as Record<string, unknown>;
			const props = Object.getOwnPropertyNames(record).find(prop => prop.startsWith("__reactProps$"));
			const handlers = props ? (record[props] as { onKeyDown?: (event: object) => void }) : {};
			return act(async () => handlers.onKeyDown?.(event));
		};
		await type(input, "alice/");
		await press({ key: "Enter", nativeEvent: { isComposing: true }, keyCode: 13 });
		// Safari reports the committing Enter as keyCode 229 with isComposing already false.
		await press({ key: "Enter", nativeEvent: { isComposing: false }, keyCode: 229 });
		expect(set).not.toHaveBeenCalled();
		await press({ key: "Enter", nativeEvent: { isComposing: false }, keyCode: 13 });
		expect(set).toHaveBeenCalledWith("worktreeBranchPrefix", "alice/");
	});
});
