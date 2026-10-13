import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { ModelValueSelect } from "../settings/ModelValueSelect";
import { ContextMenu } from "./ContextMenu";
import { Modal } from "./Modal";
import { Popover } from "./Popover";
import { Sheet } from "./Sheet";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;

async function pressEscape(isComposing = false): Promise<void> {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key: "Escape", isComposing });
	await act(async () => {
		document.dispatchEvent(event);
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = undefined;
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("nested Escape layers", () => {
	it.each(["Sheet", "Modal"] as const)("closes a dropdown before its containing %s", async parent => {
		vi.useFakeTimers();
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
		const close = vi.fn();
		function Harness() {
			const [open, setOpen] = useState(true);
			const Parent = parent === "Sheet" ? Sheet : Modal;
			return (
				<Parent
					open={open}
					onClose={() => {
						close();
						setOpen(false);
					}}
					title="Settings"
				>
					<ModelValueSelect
						ariaLabel="Choose model"
						value=""
						onCommit={() => {}}
						groups={[{ label: "Models", options: [{ value: "model-one" }] }]}
					/>
				</Parent>
			);
		}
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<I18nProvider>
					<Harness />
				</I18nProvider>,
			);
		});
		await act(async () => {
			document.querySelector<HTMLButtonElement>('button[aria-label="Choose model"]')?.click();
		});
		expect(document.querySelector('[role="listbox"]')).not.toBeNull();
		await pressEscape(true);
		expect(document.querySelector('[role="listbox"]')).not.toBeNull();
		expect(close).not.toHaveBeenCalled();
		await pressEscape();
		expect(document.querySelector('[role="listbox"]')).toBeNull();
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(close).not.toHaveBeenCalled();
		await pressEscape();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it.each(["menu", "popover"] as const)("closes a %s before its containing Sheet", async kind => {
		vi.useFakeTimers();
		const close = vi.fn();
		function Harness() {
			const [childOpen, setChildOpen] = useState(false);
			const [open, setOpen] = useState(true);
			const [anchor, setAnchor] = useState<HTMLElement | null>(null);
			return (
				<Sheet
					title="Settings"
					open={open}
					onClose={() => {
						close();
						setOpen(false);
					}}
				>
					<button
						type="button"
						onClick={event => {
							setAnchor(event.currentTarget);
							setChildOpen(true);
						}}
					>
						Open layer
					</button>
					{kind === "menu" && childOpen && (
						<ContextMenu
							x={0}
							y={0}
							onClose={() => setChildOpen(false)}
							items={[{ id: "action", label: "Action", onSelect: () => {} }]}
						/>
					)}
					{kind === "popover" && (
						<Popover
							open={childOpen}
							anchorRef={{ current: anchor }}
							onClose={() => setChildOpen(false)}
							ariaLabel="Details"
						>
							<button type="button">Action</button>
						</Popover>
					)}
				</Sheet>
			);
		}
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<I18nProvider>
					<Harness />
				</I18nProvider>,
			);
		});
		await act(async () => {
			Array.from(document.querySelectorAll("button"))
				.find(button => button.textContent === "Open layer")
				?.click();
		});
		expect(document.body.textContent).toContain("Action");
		await pressEscape();
		expect(document.body.textContent).not.toContain("Action");
		expect(close).not.toHaveBeenCalled();
		await pressEscape();
		expect(close).toHaveBeenCalledTimes(1);
	});
});
