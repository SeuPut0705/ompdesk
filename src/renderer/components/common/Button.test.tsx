/**
 * Button: a native button that never submits a form by accident, blocks clicks while disabled or loading
 * (announcing the spinner as status), and forwards native props and the ref.
 */

import { parseHTML } from "linkedom";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { Button } from "./Button";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

async function mount(node: React.ReactNode): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<I18nProvider>{node}</I18nProvider>));
}

function button(): HTMLButtonElement {
	return document.querySelector("button") as HTMLButtonElement;
}

describe("Button", () => {
	it.each(["primary", "secondary", "ghost", "danger"] as const)(
		"renders the %s variant as a native button named by its label that does not submit",
		async variant => {
			await mount(<Button variant={variant}>Save</Button>);
			expect(document.querySelectorAll("button")).toHaveLength(1);
			expect(button().textContent).toBe("Save");
			expect(button().getAttribute("type")).toBe("button");
			expect(button().disabled).toBe(false);
		},
	);

	it("lets a caller opt into submit", async () => {
		await mount(<Button type="submit">Send</Button>);
		expect(button().getAttribute("type")).toBe("submit");
	});

	it("calls onClick when enabled", async () => {
		const click = vi.fn();
		await mount(<Button onClick={click}>Go</Button>);
		await act(async () => button().click());
		expect(click).toHaveBeenCalledTimes(1);
	});

	it("blocks onClick while disabled", async () => {
		const click = vi.fn();
		await mount(
			<Button disabled onClick={click}>
				Go
			</Button>,
		);
		expect(button().disabled).toBe(true);
		await act(async () => button().click());
		expect(click).not.toHaveBeenCalled();
	});

	it("disables itself while loading, shows a status spinner, keeps its label and blocks onClick", async () => {
		const click = vi.fn();
		await mount(
			<Button loading onClick={click}>
				Saving
			</Button>,
		);
		expect(button().disabled).toBe(true);
		expect(button().textContent).toContain("Saving");
		expect(button().querySelector("[role='status']")).not.toBeNull();
		await act(async () => button().click());
		expect(click).not.toHaveBeenCalled();
	});

	it("shows no spinner when not loading", async () => {
		await mount(<Button>Idle</Button>);
		expect(button().querySelector("[role='status']")).toBeNull();
	});

	it("renders icon and trailing icon around the label", async () => {
		await mount(
			<Button icon={<svg data-testid="lead" />} trailingIcon={<svg data-testid="trail" />}>
				Open
			</Button>,
		);
		const kids = [...button().childNodes].map(
			node => (node as Element).getAttribute?.("data-testid") ?? node.textContent,
		);
		expect(kids).toEqual(["lead", "Open", "trail"]);
	});

	it("swaps the icon for the spinner while loading", async () => {
		await mount(
			<Button icon={<svg data-testid="lead" />} loading>
				Open
			</Button>,
		);
		expect(document.querySelector("[data-testid='lead']")).toBeNull();
		expect(button().querySelector("[role='status']")).not.toBeNull();
	});

	it("forwards native props and the ref to the button", async () => {
		const ref = createRef<HTMLButtonElement>();
		await mount(
			<Button aria-label="Close panel" data-action="close" id="close-btn" ref={ref} title="Close">
				x
			</Button>,
		);
		expect(ref.current).toBe(button());
		expect(button().getAttribute("aria-label")).toBe("Close panel");
		expect(button().getAttribute("data-action")).toBe("close");
		expect(button().id).toBe("close-btn");
		expect(button().getAttribute("title")).toBe("Close");
	});
});
