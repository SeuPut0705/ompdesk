import { parseHTML } from "linkedom";
import { act, createRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { Banner } from "./Banner";

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

function render(node: ReactElement) {
	return parseHTML(`<html><body>${renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>)}</body></html>`).document;
}

async function mount(node: ReactElement): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<I18nProvider>{node}</I18nProvider>));
}

describe("Banner", () => {
	it("passes DOM attributes and its ref to the row, so a banner can be a focusable region of its own", async () => {
		const ref = createRef<HTMLDivElement>();
		const onKeyDown = vi.fn();
		await mount(
			<Banner
				aria-label="What's new in 1.2"
				data-whats-new-card=""
				onKeyDown={onKeyDown}
				ref={ref}
				role="region"
				tabIndex={0}
				variant="neutral"
			>
				OMPdesk 1.2 is here.
			</Banner>,
		);
		const row = document.querySelector("[data-whats-new-card]");
		expect(ref.current).toBe(row);
		expect(row?.getAttribute("role")).toBe("region");
		expect(row?.getAttribute("aria-label")).toBe("What's new in 1.2");
		expect(row?.getAttribute("tabindex")).toBe("0");
		await act(async () => {
			const event = new Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "key", { value: "Escape" });
			row?.dispatchEvent(event);
		});
		expect(onKeyDown).toHaveBeenCalledTimes(1);
	});

	it("announces itself when live, over a role the caller gave", () => {
		const document = render(
			<Banner live role="region" variant="danger">
				Broken.
			</Banner>,
		);
		expect(document.querySelector("[role]")?.getAttribute("role")).toBe("alert");
	});

	it("names its dismiss button as asked, else Close", async () => {
		const onDismiss = vi.fn();
		await mount(
			<>
				<Banner dismissLabel="Dismiss update failure" onDismiss={onDismiss} variant="neutral">
					The update failed.
				</Banner>
				<Banner onDismiss={() => {}}>Saved.</Banner>
			</>,
		);
		const [named, plain] = [...document.querySelectorAll("button")];
		expect(named.getAttribute("aria-label")).toBe("Dismiss update failure");
		expect(plain.getAttribute("aria-label")).toBe(translate("common.close"));
		await act(async () => named.click());
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("draws a given icon in place of the variant's glyph, hidden from screen readers", () => {
		const document = render(
			<Banner icon={<svg data-brand="" />} variant="neutral">
				OMPdesk 1.2 is here.
			</Banner>,
		);
		const svgs = [...document.querySelectorAll("svg")];
		expect(svgs).toHaveLength(1);
		expect(svgs[0].hasAttribute("data-brand")).toBe(true);
		expect(svgs[0].parentElement?.getAttribute("aria-hidden")).toBe("true");
	});

	it("compact: one row whose actions and dismiss button are its own children", () => {
		const document = render(
			<Banner
				actions={<button type="button">Check again</button>}
				compact
				data-update-notice=""
				onDismiss={() => {}}
				variant="neutral"
			>
				<span>The update failed.</span>
			</Banner>,
		);
		const row = document.querySelector("[data-update-notice]");
		const buttons = [...(row?.querySelectorAll("button") ?? [])];
		expect(buttons.map(button => button.parentElement)).toEqual([row, row]);
		expect(buttons[0].textContent).toBe("Check again");
	});
});
