import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateAuthInfo, UpdateStatus } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { useUpdaterStore } from "../../stores/updater";
import { UpdateAuthRow } from "./UpdatesSection";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

interface TestElement {
	textContent: string | null;
	remove: () => void;
	querySelector: (selector: string) => TestElement | null;
}

let container: TestElement;
let root: Root;

async function mountRow(status: UpdateStatus, info: Partial<UpdateAuthInfo>): Promise<void> {
	const authInfo = { source: null, hasStoredToken: false, canStore: true, ...info } as UpdateAuthInfo;
	Reflect.set(window, "omp", { updater: { authInfo: vi.fn(async () => authInfo) } });
	useUpdaterStore.setState({ status });
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<UpdateAuthRow onChanged={async () => {}} />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useUpdaterStore.setState({ status: { state: "idle" } });
});

const tokenRow = () => container.querySelector("#settings-updates-auth");

describe("UpdateAuthRow", () => {
	it("renders nothing for a public repo with no stored token", async () => {
		await mountRow({ state: "not-available" } as UpdateStatus, {});
		expect(tokenRow()).toBeNull();
		expect(container.textContent).toBe("");
	});

	it("renders nothing while idle with no stored token", async () => {
		await mountRow({ state: "idle" }, {});
		expect(tokenRow()).toBeNull();
	});

	it("shows the row when GitHub access is required", async () => {
		await mountRow({ state: "auth-required", reason: "missing" }, {});
		expect(tokenRow()).not.toBeNull();
		expect(container.querySelector("input")).not.toBeNull();
	});

	it("shows the row with Remove when a token is stored, whatever the status", async () => {
		await mountRow({ state: "not-available" } as UpdateStatus, { hasStoredToken: true, source: "stored" });
		expect(tokenRow()).not.toBeNull();
		expect(container.textContent).toContain("Remove saved token");
	});
});
