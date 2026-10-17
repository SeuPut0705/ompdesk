/**
 * SchemaSettingRow, mounted: where a value comes from (a runtime override until the user's own write makes it
 * Global), Escape discarding a field edit without saving it, and a save that an older read cannot undo.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionRpcClient } from "../../../shared/rpc-client";
import type { RpcCommand, RpcResponse, SettingEntry } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { SchemaSettingRow } from "./SchemaSettingRow";

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
	document.body.innerHTML = "";
});

/** Stock's set_setting, answered when the test says so (or at once), recording every write. */
function stockSettings(answer: (value: unknown) => RpcResponse) {
	const writes: unknown[] = [];
	const held: Array<() => void> = [];
	let hold = false;
	const rpc = createSessionRpcClient(async (command: RpcCommand): Promise<RpcResponse> => {
		if (command.type !== "set_setting") return { type: "response", command: command.type, success: true, data: {} };
		writes.push(command.value);
		if (!hold) return answer(command.value);
		const { promise, resolve } = Promise.withResolvers<RpcResponse>();
		held.push(() => resolve(answer(command.value)));
		return promise;
	});
	Object.assign(window, { omp: { rpc } });
	return {
		writes,
		holdNext: () => {
			hold = true;
		},
		/** Answer the newest held write first, then the older ones. */
		release: () => held.pop()?.(),
	};
}

const saved = (value: unknown, layers: ("global" | "runtime")[]): RpcResponse => ({
	type: "response",
	command: "set_setting",
	success: true,
	data: { value, provenance: { layers, globalValue: value } },
});

const entry = (patch: Partial<SettingEntry> = {}): SettingEntry => ({
	path: "compaction.reserveTokens",
	type: "number",
	value: 8192,
	default: 16_384,
	label: "Reserve tokens",
	...patch,
});

async function mount(row: SettingEntry, value: unknown, onCommitted = vi.fn()) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const render = (next: unknown) =>
		act(async () => {
			root?.render(
				<I18nProvider>
					<SchemaSettingRow entry={row} onCommitted={onCommitted} showSource value={next} />
				</I18nProvider>,
			);
		});
	await render(value);
	return { render, onCommitted };
}

function field(): HTMLInputElement {
	const input = document.querySelector("input");
	if (!input) throw new Error("no field");
	return input as unknown as HTMLInputElement;
}

/** linkedom fires no React events: call the field's own handlers, read fresh after every render. */
function handlers(): Record<string, (event: object) => void> {
	const record = field() as unknown as Record<string, unknown>;
	const key = Object.keys(record).find(name => name.startsWith("__reactProps$"));
	return key ? (record[key] as Record<string, (event: object) => void>) : {};
}

async function type(value: string): Promise<void> {
	await act(async () => handlers().onChange?.({ target: { value }, currentTarget: { value } }));
}

async function key(name: string): Promise<{ prevented: boolean; stopped: boolean }> {
	const seen = { prevented: false, stopped: false };
	await act(async () =>
		handlers().onKeyDown?.({
			key: name,
			nativeEvent: {},
			currentTarget: field(),
			preventDefault: () => {
				seen.prevented = true;
			},
			stopPropagation: () => {
				seen.stopped = true;
			},
		}),
	);
	return seen;
}

async function blur(): Promise<void> {
	await act(async () => handlers().onBlur?.({ currentTarget: field() }));
}

async function settle(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

describe("SchemaSettingRow", () => {
	it("names a held default as a runtime override, and the user's own write makes it Global", async () => {
		stockSettings(value => saved(value, ["global"]));
		await mount(entry({ provenance: { layers: ["runtime"], globalValue: 8192 } }), 8192);
		expect(document.body.textContent).toContain(translate("settings.source.runtime"));
		await type("12345");
		await blur();
		await settle();
		expect(document.body.textContent).toContain(translate("settings.source.global"));
		expect(document.body.textContent).not.toContain(translate("settings.source.runtime"));
	});

	it("Escape puts the saved value back and saves nothing; with no edit it leaves Escape alone", async () => {
		const stock = stockSettings(value => saved(value, ["global"]));
		await mount(entry(), 8192);
		await type("12345");
		expect(field().value).toBe("12345");
		expect(await key("Escape")).toEqual({ prevented: true, stopped: true });
		await blur();
		await settle();
		expect(field().value).toBe("8192");
		expect(stock.writes).toEqual([]);
		// Nothing pending: this Escape is the page's (it goes back to the session).
		expect(await key("Escape")).toEqual({ prevented: false, stopped: false });
	});

	it("a later save wins over an earlier one still in flight", async () => {
		const stock = stockSettings(value => saved(value, ["global"]));
		const { onCommitted } = await mount(entry(), 8192);
		stock.holdNext();
		await type("10000");
		await blur();
		await type("12345");
		await blur();
		expect(stock.writes).toEqual([10000, 12345]);
		// The newer answer lands first; the older one arrives after and is ignored.
		await act(async () => {
			stock.release();
			stock.release();
		});
		await settle();
		expect(onCommitted.mock.calls.map(call => call[1])).toEqual([12345]);
	});
});
