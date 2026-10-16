import { parseHTML } from "linkedom";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PHONE_QUERY, resetShellModeForTests, TABLET_PORTRAIT_QUERY, TOUCH_QUERY } from "../../hooks/use-shell-mode";
import { backLayerDepth } from "../../lib/back-layer";
import { I18nProvider } from "../../lib/i18n";
import { MasterDetail } from "./MasterDetail";

const { document, window, Event } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.IS_REACT_ACT_ENVIRONMENT = true;

/** The three shell queries answering for a viewport; `web` false is an Electron window. */
function viewport(width: number, height: number, web = true): void {
	if (web) document.documentElement.dataset.platform = "web";
	else document.documentElement.dataset.platform = "darwin";
	const answers: Record<string, boolean> = {
		[PHONE_QUERY]: width < 600 || (height < 500 && width > height),
		[TABLET_PORTRAIT_QUERY]: width < 1000,
		[TOUCH_QUERY]: true,
	};
	const history: unknown[] = [];
	Object.assign(window, {
		matchMedia: (query: string) => ({
			matches: answers[query] ?? false,
			addEventListener: () => {},
			removeEventListener: () => {},
		}),
		location: { search: "" },
		history: { pushState: (state: unknown) => history.push(state), back: () => {} },
	});
}

function Probe({ initial = false, onBack }: { initial?: boolean; onBack?: () => void }) {
	const [open, setOpen] = useState(initial);
	return (
		<MasterDetail
			detail={<p data-detail>Detail of the row</p>}
			label="Items"
			list={
				<button data-row onClick={() => setOpen(true)} type="button">
					Row
				</button>
			}
			onBack={() => {
				onBack?.();
				setOpen(false);
			}}
			open={open}
		/>
	);
}

let root: Root | undefined;

async function mount(element: ReactElement): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<I18nProvider>{element}</I18nProvider>));
}

const click = (selector: string) =>
	act(async () => {
		document.querySelector(selector)?.dispatchEvent(new Event("click", { bubbles: true }));
	});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	resetShellModeForTests();
	delete document.documentElement.dataset.platform;
	delete document.documentElement.dataset.shell;
	delete document.documentElement.dataset.input;
});

describe("MasterDetail", () => {
	it("shows the list and the detail side by side on a landscape tablet, a portrait tablet and a desktop window", async () => {
		for (const [width, height, web] of [
			[1194, 834, true],
			[834, 1194, true],
			[500, 700, false],
		] as const) {
			viewport(width, height, web);
			await mount(<Probe />);
			expect(document.querySelector('[data-master-detail="split"]')).not.toBeNull();
			expect(document.querySelector('nav[aria-label="Items"] [data-row]')).not.toBeNull();
			expect(document.querySelector("[data-detail]")).not.toBeNull();
			expect(document.querySelector("[data-master-detail-back]")).toBeNull();
			await act(async () => root?.unmount());
			root = undefined;
			document.body.innerHTML = "";
			resetShellModeForTests();
		}
	});

	it("is one pane on a phone: the list, then the detail under a back button, then the list again", async () => {
		viewport(390, 844);
		await mount(<Probe />);
		expect(document.querySelector('[data-pane="list"]')).not.toBeNull();
		expect(document.querySelector("[data-detail]")).toBeNull();

		await click("[data-row]");
		expect(document.querySelector('[data-pane="detail"]')).not.toBeNull();
		expect(document.querySelector("[data-detail]")?.textContent).toBe("Detail of the row");
		expect(document.querySelector("[data-row]")).toBeNull();
		expect(document.querySelector("[data-master-detail-back]")?.textContent).toContain("Back");

		await click("[data-master-detail-back]");
		expect(document.querySelector('[data-pane="list"]')).not.toBeNull();
		expect(document.querySelector("[data-detail]")).toBeNull();
	});

	it("takes a back layer while its detail is open, so the system back gesture closes the detail", async () => {
		viewport(390, 844);
		let backed = 0;
		await mount(
			<Probe
				onBack={() => {
					backed += 1;
				}}
			/>,
		);
		expect(backLayerDepth()).toBe(0);
		await click("[data-row]");
		expect(backLayerDepth()).toBe(1);
		await act(async () => {
			window.dispatchEvent(new Event("popstate"));
		});
		expect(backed).toBe(1);
		expect(document.querySelector('[data-pane="list"]')).not.toBeNull();
		expect(backLayerDepth()).toBe(0);
	});

	it("opens straight on the detail when a row is already chosen", async () => {
		viewport(390, 844);
		await mount(<Probe initial />);
		expect(document.querySelector("[data-detail]")).not.toBeNull();
		expect(document.querySelector("[data-master-detail-back]")).not.toBeNull();
	});
});
