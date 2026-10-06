import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { ModelEditor, type ModelRow } from "./ModelEditor";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

interface TestElement {
	value: string;
	dispatchEvent(event: object): boolean;
	remove(): void;
}

let container: TestElement;
let root: Root;

async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => target.dispatchEvent(event));
}

async function typeInto(element: TestElement, value: string): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
	descriptor?.set?.call(element, value);
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void } | undefined) : undefined;
	await act(async () => props?.onChange?.({ target: element, currentTarget: element }));
}

function Harness({ onUpdate }: { onUpdate: (model: ModelRow) => void }) {
	const [model, setModel] = useState<ModelRow>({ key: 1, id: "priced-model" });
	return (
		<ModelEditor
			model={model}
			readonly={false}
			disabled={false}
			onUpdate={(_key, patch) =>
				setModel(current => {
					const next = { ...current, ...patch };
					onUpdate(next);
					return next;
				})
			}
			onRemove={vi.fn()}
			canRemove={false}
		/>
	);
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

describe("ModelEditor pricing", () => {
	it("preserves leading zero decimals while storing zero and fractional prices", async () => {
		let latest: ModelRow | undefined;
		container = document.createElement("div") as unknown as TestElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root.render(
				<I18nProvider>
					<Harness onUpdate={model => (latest = model)} />
				</I18nProvider>,
			);
		});

		const expand = document.querySelector("button") as unknown as TestElement;
		await dispatch(expand, new Event("click", { bubbles: true, cancelable: true }));
		const input = document.querySelector('input[step="any"]') as unknown as TestElement;

		await typeInto(input, "0");
		expect(input.value).toBe("0");
		expect(latest?.cost?.input).toBe(0);

		await typeInto(input, "0.14");
		expect(input.value).toBe("0.14");
		expect(latest?.cost?.input).toBe(0.14);

		await typeInto(input, "0.014");
		expect(input.value).toBe("0.014");
		expect(latest?.cost?.input).toBe(0.014);
	});
});
