/**
 * ConfirmDialog: a titled dialog whose Cancel and Escape both call onCancel, whose confirm calls onConfirm,
 * and whose confirm is blocked while busy. Cancel is the autofocused (safe) action.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let activeElement: HTMLElement | null = null;
Object.defineProperty(document, "activeElement", {
	configurable: true,
	get: () => activeElement,
});

let root: Root | undefined;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	activeElement = null;
	vi.restoreAllMocks();
});

function dialog(): Element | null {
	return document.querySelector("[role='dialog']");
}

function buttons(): HTMLButtonElement[] {
	return [...(dialog()?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
}

function buttonNamed(name: string): HTMLButtonElement {
	const found = buttons().find(button => button.textContent?.includes(name));
	if (!found) throw new Error(`no button "${name}"`);
	return found;
}

async function pressEscape(): Promise<void> {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperties(event, { key: { value: "Escape" }, keyCode: { value: 27 }, isComposing: { value: false } });
	await act(async () => {
		document.dispatchEvent(event);
	});
	await flush();
}

describe("ConfirmDialog", () => {
	it("opens as a dialog named by its title, with the message and warning", async () => {
		await mount(
			<ConfirmDialog
				message="This removes the worktree."
				onCancel={() => {}}
				onConfirm={() => {}}
				open
				title="Delete worktree?"
				warning="Uncommitted work is lost."
			/>,
		);
		expect(dialog()).not.toBeNull();
		const labelId = dialog()?.getAttribute("aria-labelledby") ?? "";
		expect(document.getElementById(labelId)?.textContent).toBe("Delete worktree?");
		expect(dialog()?.textContent).toContain("This removes the worktree.");
		expect(dialog()?.textContent).toContain("Uncommitted work is lost.");
	});

	it("renders nothing while closed", async () => {
		await mount(<ConfirmDialog message="m" onCancel={() => {}} onConfirm={() => {}} open={false} title="T" />);
		expect(dialog()).toBeNull();
	});

	it("calls onConfirm, and only onConfirm, from the confirm button", async () => {
		const confirm = vi.fn();
		const cancel = vi.fn();
		await mount(
			<ConfirmDialog
				cancelLabel="Keep"
				confirmLabel="Remove"
				message="m"
				onCancel={cancel}
				onConfirm={confirm}
				open
				title="T"
			/>,
		);
		await act(async () => buttonNamed("Remove").click());
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(cancel).not.toHaveBeenCalled();
	});

	it("calls onCancel, and only onCancel, from the cancel button", async () => {
		const confirm = vi.fn();
		const cancel = vi.fn();
		await mount(
			<ConfirmDialog
				cancelLabel="Keep"
				confirmLabel="Remove"
				message="m"
				onCancel={cancel}
				onConfirm={confirm}
				open
				title="T"
			/>,
		);
		await act(async () => buttonNamed("Keep").click());
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("calls onCancel on Escape and never confirms", async () => {
		const confirm = vi.fn();
		const cancel = vi.fn();
		await mount(<ConfirmDialog message="m" onCancel={cancel} onConfirm={confirm} open title="T" />);
		await pressEscape();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("moves focus into the dialog, onto the safe cancel action", async () => {
		vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
			activeElement = this;
		});
		await mount(
			<ConfirmDialog
				cancelLabel="Keep"
				confirmLabel="Remove"
				message="m"
				onCancel={() => {}}
				onConfirm={() => {}}
				open
				title="T"
			/>,
		);
		expect(dialog()?.contains(activeElement)).toBe(true);
		expect(activeElement).toBe(buttonNamed("Keep"));
	});

	it("blocks confirming while busy but still lets the user cancel", async () => {
		const confirm = vi.fn();
		const cancel = vi.fn();
		await mount(
			<ConfirmDialog
				busy
				cancelLabel="Keep"
				confirmLabel="Remove"
				message="m"
				onCancel={cancel}
				onConfirm={confirm}
				open
				title="T"
			/>,
		);
		expect(buttonNamed("Remove").disabled).toBe(true);
		expect(buttonNamed("Remove").querySelector("[role='status']")).not.toBeNull();
		await act(async () => buttonNamed("Remove").click());
		expect(confirm).not.toHaveBeenCalled();
		expect(buttonNamed("Keep").disabled).toBe(false);
		await act(async () => buttonNamed("Keep").click());
		expect(cancel).toHaveBeenCalledTimes(1);
	});
});
