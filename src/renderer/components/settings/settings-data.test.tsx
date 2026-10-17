/**
 * useSettingsDataLoader: a refresh that config_update started before the user's own save cannot put the old value
 * back when it answers after the save.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionRpcClient } from "../../../shared/rpc-client";
import type { RpcCommand, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { type SettingsData, useSettingsDataLoader } from "./settings-data";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root | undefined;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	useSessionStore.getState().reset();
});

const PATH = "compaction.reserveTokens";
const response = (command: string, data: unknown): RpcResponse => ({ type: "response", command, success: true, data });

async function settle(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

describe("useSettingsDataLoader", () => {
	it("ignores a refresh that answers after the user's own save", async () => {
		let stored = 8192;
		const held: Array<() => void> = [];
		let holdReads = false;
		const configListeners: Array<() => void> = [];
		const rpc = createSessionRpcClient(async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type === "get_settings_schema")
				return response(command.type, {
					tabs: ["context"],
					entries: [{ path: PATH, type: "number", value: stored, default: 16_384, tab: "context" }],
				});
			if (command.type === "get_settings") {
				const value = stored;
				const answer = response(command.type, { values: { [PATH]: value } });
				if (!holdReads) return answer;
				const { promise, resolve } = Promise.withResolvers<RpcResponse>();
				held.push(() => resolve(answer));
				return promise;
			}
			return response(command.type, {});
		});
		Object.assign(window, {
			omp: {
				rpc,
				events: {
					onConfigUpdate: (listener: () => void) => {
						configListeners.push(listener);
						return () => {};
					},
				},
			},
		});
		useSessionStore.setState({ status: "ready" });
		let data: SettingsData | undefined;
		function Probe() {
			data = useSettingsDataLoader();
			return null;
		}
		const container = document.createElement("div");
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<I18nProvider>
					<Probe />
				</I18nProvider>,
			),
		);
		await settle();
		expect(data?.values[PATH]).toBe(8192);

		// Another client edits the config: the page re-reads, and that read is slow (it saw 8192).
		holdReads = true;
		await act(async () => {
			for (const listener of configListeners) listener();
		});
		// Meanwhile the user saves 12345 here.
		stored = 12345;
		await act(async () => data?.onCommitted(PATH, 12345));
		expect(data?.values[PATH]).toBe(12345);
		// The old read lands: it must not undo the save.
		await act(async () => {
			for (const answer of held.splice(0)) answer();
		});
		await settle();
		expect(data?.values[PATH]).toBe(12345);
	});
});
