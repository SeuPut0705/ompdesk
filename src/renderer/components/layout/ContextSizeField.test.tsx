import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { ContextSizeField } from "./ContextSizeField";

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

const ok = (data: unknown): RpcResponse => ({ type: "response", command: "x", success: true, data });
let thresholds: Record<string, unknown> = { "acme/big": "80%", "acme/other": 90_000 };
const rpc = {
	getSettings: vi.fn(async (paths?: string[]) =>
		ok({
			values: { "compaction.modelThresholds": thresholds, extendedContext: false, paths },
			provenance: { "compaction.modelThresholds": { layers: ["global"], globalValue: thresholds } },
		}),
	),
	setSetting: vi.fn(async (_path: string, value: unknown) => {
		if (_path === "compaction.modelThresholds") thresholds = (value as Record<string, unknown> | undefined) ?? {};
		return ok({ value });
	}),
	compactionLimits: vi.fn(async (args: { input?: string }) => ok({ ok: true, value: args.input })),
};
Object.assign(window, { omp: { rpc, events: { onBatch: () => () => {}, onConfigUpdate: () => () => {} } } });

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root.render(<I18nProvider>{<ContextSizeField />}</I18nProvider>));
	await act(async () => {});
}

async function choose(value: string): Promise<void> {
	const select = container.querySelector("select") as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(select).find(name => name.startsWith("__reactProps$"));
	const props = key ? (select[key] as { onChange?: (event: object) => void }) : undefined;
	await act(async () => props?.onChange?.({ target: { value }, currentTarget: { value } }));
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.clearAllMocks();
	thresholds = { "acme/big": "80%", "acme/other": 90_000 };
	useSessionStore.getState().reset();
});

describe("ContextSizeField", () => {
	it("shows the model's own limit and writes a new one through stock validation, keeping other models", async () => {
		useSessionStore.setState({ status: "ready" });
		useModelStore.setState({ model: { provider: "acme", id: "big" } as never });
		await mount();
		expect((container.querySelector("select") as unknown as { value: string }).value).toBe("80%");
		await choose("60%");
		expect(rpc.compactionLimits).toHaveBeenCalledWith({ key: "acme/big", input: "60%" });
		expect(rpc.setSetting).toHaveBeenCalledWith("compaction.modelThresholds", {
			"acme/big": "60%",
			"acme/other": 90_000,
		});
	});

	it("Default removes only this model's entry, and unsets the map once it is empty", async () => {
		useSessionStore.setState({ status: "ready" });
		useModelStore.setState({ model: { provider: "acme", id: "big" } as never });
		thresholds = { "acme/big": "80%" };
		await mount();
		await choose("default");
		expect(rpc.compactionLimits).not.toHaveBeenCalled();
		expect(rpc.setSetting).toHaveBeenCalledWith("compaction.modelThresholds", undefined);
	});
});
