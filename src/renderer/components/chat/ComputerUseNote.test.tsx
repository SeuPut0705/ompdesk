import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { COMPUTER_USE_NOTICE_TYPE } from "../../../../resources/gui-bridge/modes/computer-use-contracts";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { ComputerUseNote } from "./ComputerUseNote";

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

let container: HTMLElement;
let root: Root;

async function show(details: unknown): Promise<string> {
	const message: AgentMessage = {
		role: "custom",
		customType: COMPUTER_USE_NOTICE_TYPE,
		content: "",
		display: true,
		details,
		timestamp: 1,
	};
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ComputerUseNote message={message} />
			</I18nProvider>,
		);
	});
	return container.textContent ?? "";
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

describe("computer use fallback note", () => {
	it("says agent-desktop is not installed and where to change the engine", async () => {
		const text = await show({ v: 1, reason: "missing" });

		expect(text).toContain("agent-desktop isn't available here, so this session uses the built-in computer use.");
		expect(text).toContain("Not installed yet.");
		expect(text).toContain("Settings › Agent behavior › Computer use");
	});

	it("says why the server did not start", async () => {
		const text = await show({ v: 1, reason: "failed", error: "spawn ENOENT" });

		expect(text).toContain("It didn't start: spawn ENOENT");
		expect(text).not.toContain("Not installed yet.");
	});

	it("shows nothing for details that are no notice", async () => {
		expect(await show({ reason: "other" })).toBe("");
	});
});
