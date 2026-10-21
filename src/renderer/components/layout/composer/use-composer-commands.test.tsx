/**
 * The tab's slash commands across a failed read: a read a dropped link (a phone page during a relaunch) or a closed
 * bridge fails keeps the commands already shown and leaves no rejection unhandled.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvailableCommand, RpcResponse } from "../../../../shared/rpc-types";
import type { TabRpc } from "../../../lib/tab-rpc";
import { useComposerCommands } from "./use-composer-commands";

const { document, window, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

let deliver: ((commands: AvailableCommand[], tabId: string) => void) | undefined;
Object.assign(window, {
	omp: {
		events: {
			onTabCommandsUpdate: (callback: (commands: AvailableCommand[], tabId: string) => void) => {
				deliver = callback;
				return () => {};
			},
		},
	},
});

let root: Root | undefined;
let shown: AvailableCommand[] = [];

function Probe({ rpc, status }: { rpc: TabRpc; status: string }) {
	shown = useComposerCommands({ rpc, status, sessionId: null, runtimeTabId: "t0" });
	return null;
}

async function render(rpc: TabRpc, status: string): Promise<void> {
	if (!root) {
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container as unknown as Element);
	}
	await act(async () => root?.render(<Probe rpc={rpc} status={status} />));
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	shown = [];
});

describe("useComposerCommands", () => {
	it("keeps the commands it has when a read fails, and handles the failure", async () => {
		const getAvailableCommands = vi.fn<() => Promise<RpcResponse>>(() =>
			Promise.reject(new Error("The link to the computer dropped")),
		);
		const rpc = { getAvailableCommands } as unknown as TabRpc;
		const unhandled: unknown[] = [];
		const listen = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", listen);
		try {
			await render(rpc, "starting");
			await act(async () => deliver?.([{ name: "my_cmd", description: "Ext", source: "extension" }], "t0"));
			const before = shown.map(command => command.name);
			expect(before).toContain("my_cmd");
			await render(rpc, "ready");
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(getAvailableCommands).toHaveBeenCalled();
			expect(shown.map(command => command.name)).toEqual(before);
		} finally {
			process.off("unhandledRejection", listen);
		}
		expect(unhandled).toEqual([]);
	});
});
