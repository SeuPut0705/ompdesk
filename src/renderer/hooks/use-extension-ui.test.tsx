/**
 * The answer path of an ask on a tab other windows show too: the first answer wins, and a window that
 * answers second is told the card was answered elsewhere instead of seeing an error.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codedError } from "../../shared/ipc-error-codes";
import type { ExtensionUIResponse } from "../../shared/rpc-types";
import { translate } from "../lib/i18n";
import { useToastStore } from "../stores/toast";
import { useExtensionUiResponder } from "./use-extension-ui";

const { document, window, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

const respondExtensionUi = vi.fn<(response: ExtensionUIResponse, tabId?: string) => Promise<void>>();
Object.assign(window, { omp: { ui: { respondExtensionUi } } });

let root: Root | undefined;
let respond: ReturnType<typeof useExtensionUiResponder> | undefined;

function Probe() {
	respond = useExtensionUiResponder();
	return null;
}

async function mount(): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<Probe />));
}

const answer: ExtensionUIResponse = { type: "extension_ui_response", id: "ask-1", confirmed: true };

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	respond = undefined;
	respondExtensionUi.mockReset();
	useToastStore.setState({ toasts: [] });
});

describe("useExtensionUiResponder", () => {
	it("resolves true and says nothing when the answer was taken", async () => {
		respondExtensionUi.mockResolvedValue(undefined);
		await mount();
		expect(await respond?.(answer)).toBe(true);
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("resolves true with the answered-elsewhere notice when another window answered first", async () => {
		respondExtensionUi.mockRejectedValue(codedError("already_answered", "Already answered."));
		await mount();
		expect(await respond?.(answer)).toBe(true);
		expect(useToastStore.getState().toasts.map(toast => [toast.variant, toast.message])).toEqual([
			["info", translate("extDialog.answeredElsewhere")],
		]);
	});

	it("keeps the card open with an error toast for any other failure", async () => {
		respondExtensionUi.mockRejectedValue(new Error("link down"));
		await mount();
		expect(await respond?.(answer)).toBe(false);
		const [toast] = useToastStore.getState().toasts;
		expect(toast?.variant).toBe("error");
		expect(toast?.title).toBe(translate("extDialog.answerFailed"));
	});
});
