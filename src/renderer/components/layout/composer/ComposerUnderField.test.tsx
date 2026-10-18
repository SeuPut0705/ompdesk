/** The under-field rows: the shared-tab line (owner and viewer wording) and that it stays out of the way when nobody shares. */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider, translate } from "../../../lib/i18n";
import { setFocusedSessionRuntime } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";

const { document, window } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, { document, window, IS_REACT_ACT_ENVIRONMENT: true });

const { createRoot } = await import("react-dom/client");
const { ComposerUnderField } = await import("./ComposerUnderField");

const idle = { phase: "idle", levels: [], startedAt: null, failure: null, dismissFailure: () => {} } as const;
let root: Root | undefined;

async function render(): Promise<Element> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<ComposerUnderField dictation={idle} />
			</I18nProvider>,
		);
	});
	return container as unknown as Element;
}

function tab(extra: { shared?: true; viewerCount?: number }): void {
	useTabsStore.setState({ tabs: [{ id: "t1", ...extra } as never] });
	setFocusedSessionRuntime("t1");
}

afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.innerHTML = "";
	setFocusedSessionRuntime(null);
	useTabsStore.getState().reset();
});

describe("shared line", () => {
	it("is absent on a tab only this window shows", async () => {
		tab({});
		const view = await render();
		expect(view.querySelector("[data-composer-shared]")).toBeNull();
	});

	it("counts the other devices, in the chip's words", async () => {
		tab({ viewerCount: 1 });
		let view = await render();
		expect(view.querySelector("[data-composer-shared]")?.textContent).toBe(translate("viewers.composerOne"));
		await act(async () => root?.unmount());
		tab({ shared: true, viewerCount: 2 });
		view = await render();
		expect(view.querySelector("[data-composer-shared]")?.textContent).toBe(
			translate("viewers.composerMany", { count: 2 }),
		);
	});

	it("a viewer window without a count says the tab is open on another computer", async () => {
		tab({ shared: true });
		const view = await render();
		expect(view.querySelector("[data-composer-shared]")?.textContent).toBe(translate("viewers.composerViewer"));
	});
});
