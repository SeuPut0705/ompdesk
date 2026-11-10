/** Chip: a toggle says its state and reports the flip; a removable chip's label and ✕ are separate, named actions. */

import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Chip } from "./Chip";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

async function mount(node: React.ReactNode): Promise<void> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () => root?.render(node));
}

const byName = (name: string) => document.querySelector(`[aria-label="${name}"]`) as unknown as HTMLElement;

it("toggles: says whether it is on, reports the flip and leads with a ✓ only while on", async () => {
	const change = vi.fn();
	function Toggle() {
		const [on, setOn] = useState(false);
		return (
			<Chip
				data-focus-area="tests"
				onPressedChange={next => {
					change(next);
					setOn(next);
				}}
				pressed={on}
			>
				Tests
			</Chip>
		);
	}
	await mount(<Toggle />);
	const chip = document.querySelector("button") as unknown as HTMLElement;
	expect(chip.getAttribute("data-focus-area")).toBe("tests");
	expect(chip.getAttribute("aria-pressed")).toBe("false");
	expect(chip.querySelector("svg")).toBeNull();
	await act(async () => chip.click());
	expect(change).toHaveBeenLastCalledWith(true);
	expect(chip.getAttribute("aria-pressed")).toBe("true");
	expect(chip.querySelector("svg")).not.toBeNull();
	await act(async () => chip.click());
	expect(change).toHaveBeenLastCalledWith(false);
});

it("carries a label action and a remove action, each named, and refuses both while disabled", async () => {
	const edit = vi.fn();
	const remove = vi.fn();
	await mount(
		<ul>
			<Chip
				actionLabel="Edit queued: fix tests"
				as="li"
				onClick={edit}
				onRemove={remove}
				removeLabel="Remove fix tests"
			>
				fix tests
			</Chip>
			<Chip as="li" disabled onClick={edit} onRemove={remove} removeLabel="Remove sending">
				sending
			</Chip>
		</ul>,
	);
	expect(document.querySelectorAll("li")).toHaveLength(2);
	await act(async () => byName("Edit queued: fix tests").click());
	await act(async () => byName("Remove fix tests").click());
	expect(edit).toHaveBeenCalledTimes(1);
	expect(remove).toHaveBeenCalledTimes(1);
	await act(async () => byName("Remove sending").click());
	expect(remove).toHaveBeenCalledTimes(1);
	expect((byName("Remove sending") as unknown as HTMLButtonElement).disabled).toBe(true);
});

it("lets a roving row reach its label and ✕, and refuses the label alone while the ✕ still removes", async () => {
	const open = vi.fn();
	const remove = vi.fn();
	let root: HTMLElement | null = null;
	await mount(
		<Chip
			data-strip-item=""
			labelAttrs={{ "data-strip-stop": "" }}
			labelDisabled
			onClick={open}
			onRemove={remove}
			ref={node => {
				root = node;
			}}
			removeAttrs={{ "data-strip-remove": "", tabIndex: -1 }}
			removeLabel="Remove notes.md"
			tone="warning"
		>
			notes.md
		</Chip>,
	);
	const stop = document.querySelector("[data-strip-item] [data-strip-stop]") as unknown as HTMLButtonElement;
	const cross = document.querySelector("[data-strip-item] [data-strip-remove]") as unknown as HTMLButtonElement;
	expect(root).toBe(document.querySelector("[data-strip-item]"));
	expect(stop.textContent).toBe("notes.md");
	expect(stop.disabled).toBe(false);
	expect(stop.getAttribute("aria-disabled")).toBe("true");
	expect(cross.getAttribute("aria-label")).toBe("Remove notes.md");
	expect(cross.getAttribute("tabindex")).toBe("-1");
	await act(async () => stop.click());
	await act(async () => cross.click());
	expect(open).not.toHaveBeenCalled();
	expect(remove).toHaveBeenCalledTimes(1);
});
