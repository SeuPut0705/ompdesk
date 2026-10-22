/** DisclosureButton: says whether it is open, turns its decorative chevron, toggles on a click and never submits. */

import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DisclosureButton } from "./DisclosureButton";

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

function Section({ onSubmit }: { onSubmit: () => void }) {
	const [open, setOpen] = useState(false);
	return (
		<form onSubmit={onSubmit}>
			<DisclosureButton onToggle={() => setOpen(value => !value)} open={open}>
				Advanced
			</DisclosureButton>
			{open && <p data-body>Body</p>}
		</form>
	);
}

it("opens and folds what is under it, says so, and turns its chevron without naming it", async () => {
	const onSubmit = vi.fn();
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () => root?.render(<Section onSubmit={onSubmit} />));
	const button = host.querySelector("button") as unknown as HTMLElement;
	const chevron = () => button.querySelector("svg");

	expect(button.getAttribute("type")).toBe("button");
	expect(button.getAttribute("aria-expanded")).toBe("false");
	expect(chevron()?.getAttribute("aria-hidden")).toBe("true");
	expect(chevron()?.getAttribute("style") ?? "").not.toContain("rotate");
	expect(button.textContent).toBe("Advanced");

	await act(async () => button.click());
	expect(button.getAttribute("aria-expanded")).toBe("true");
	expect(chevron()?.getAttribute("style")).toContain("rotate(90deg)");
	expect(host.querySelector("[data-body]")).not.toBeNull();

	await act(async () => button.click());
	expect(button.getAttribute("aria-expanded")).toBe("false");
	expect(host.querySelector("[data-body]")).toBeNull();
	expect(onSubmit).not.toHaveBeenCalled();
});
