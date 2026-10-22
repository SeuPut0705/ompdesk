/** LinkButton: a named, non-submitting button in text that runs its action and never submits its form. */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LinkButton } from "./LinkButton";

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

it("runs its action as a button that does not submit, named by its text", async () => {
	const onClick = vi.fn();
	const onSubmit = vi.fn();
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () =>
		root?.render(
			<form onSubmit={onSubmit}>
				Sign in to <LinkButton onClick={onClick}>OpenRouter</LinkButton> to use it.
			</form>,
		),
	);
	const button = host.querySelector("button") as unknown as HTMLElement;
	expect(button.getAttribute("type")).toBe("button");
	expect(button.textContent).toBe("OpenRouter");
	await act(async () => button.click());
	expect(onClick).toHaveBeenCalledTimes(1);
	expect(onSubmit).not.toHaveBeenCalled();
});
