/** A session's name beside its automatic title: the person's name first, the automatic one muted and cut first. */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { TitleParts } from "../../lib/session-title";
import { SessionTitle } from "./SessionTitle";

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

let root: Root | undefined;

async function show(parts: TitleParts, extra: { live?: "turn" | null } = {}): Promise<void> {
	root ??= createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(<SessionTitle parts={parts} {...extra} />);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

describe("SessionTitle", () => {
	it("shows the name and, muted beside it, the automatic title", async () => {
		await show({ title: "Release prep", auto: "Fix login bug" });
		const whole = document.querySelector("[data-session-title]");
		const auto = document.querySelector("[data-title-auto]");
		expect(whole?.textContent).toContain("Release prep");
		expect(auto?.textContent).toContain("Fix login bug");
		expect(auto?.className).toContain("text-(--sc-text-muted)");
		expect(document.querySelector("[data-title-name]")?.className).not.toContain("text-(--sc-text-muted)");
		expect(whole?.getAttribute("title")).toBe("Release prep · Fix login bug");
	});

	it("shows the name alone without an automatic title", async () => {
		await show({ title: "Release prep" });
		expect(document.querySelector("[data-session-title]")?.textContent).toBe("Release prep");
		expect(document.querySelector("[data-title-auto]")).toBeNull();
		expect(document.querySelector("[data-session-title]")?.getAttribute("title")).toBe("Release prep");
	});

	it("keeps the working light on the name only", async () => {
		await show({ title: "Release prep", auto: "Fix login bug" }, { live: "turn" });
		const name = document.querySelector("[data-title-name]");
		expect(name?.querySelector("[data-working]")).not.toBeNull();
		expect(document.querySelector("[data-title-auto] [data-working]")).toBeNull();
	});
});
