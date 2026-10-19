/**
 * The tool-approval card under stock's "Ask and remember" (`always-ask-cached`): every remembering answer stock offers
 * is a choice in stock's order with words that say what it remembers and for how long, and each sends stock's own
 * option. A plain prompt keeps Approve, the session option and Deny. Stock's shapes: src/main/tool-approval-stock.test.ts.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import type { ApprovalSelect } from "../../stores/extension-ui";
import { ApprovalDialog, type ApprovalResponse } from "./ApprovalDialog";

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
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

const roots: Root[] = [];

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

function request(options: string[]): ApprovalSelect {
	return {
		type: "extension_ui_request",
		id: "a1",
		method: "select",
		title: "Allow tool: read\n~/project/src/notes.txt",
		options,
	};
}

async function mount(options: string[]): Promise<(response: ApprovalResponse) => void> {
	const onRespond = vi.fn<(response: ApprovalResponse) => void>();
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host as unknown as Element);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ApprovalDialog arrivedAt={undefined} onRespond={onRespond} remaining={null} request={request(options)} />
			</I18nProvider>,
		);
	});
	return onRespond;
}

/** Each choice row: stock's option it sends and the words it shows. */
function rows(): { option: string | null; text: string }[] {
	return Array.from(document.body.querySelectorAll("[data-choice]")).map(row => ({
		option: row.getAttribute("data-choice"),
		text: row.textContent ?? "",
	}));
}

describe("ApprovalDialog under Ask and remember", () => {
	it("lists the folder and file to remember for this session, then for every session, then once, session and Deny", async () => {
		const options = [
			"Approve Directory: ~/project/src",
			"Approve File",
			"Always Approve Directory: ~/project/src",
			"Always Approve File",
			"Approve Once",
			"Approve read for this session",
			"Deny",
		];
		const onRespond = await mount(options);
		const shown = rows();
		expect(shown.map(row => row.option)).toEqual(options);
		expect(shown.map(row => row.text)).toEqual([
			expect.stringContaining(translate("approval.grant.folder", { folder: "~/project/src" })),
			expect.stringContaining(translate("approval.grant.file")),
			expect.stringContaining(translate("approval.grant.folderAlways", { folder: "~/project/src" })),
			expect.stringContaining(translate("approval.grant.fileAlways")),
			expect.stringContaining(translate("approval.approveOnce")),
			expect.stringContaining(translate("approval.approveSession", { subject: "read" })),
			expect.stringContaining(translate("approval.deny")),
		]);

		await act(async () => {
			(document.body.querySelector('[data-choice="Always Approve File"]') as HTMLButtonElement | null)?.click();
		});
		expect(onRespond).toHaveBeenCalledWith({ value: "Always Approve File" });
	});

	it("keeps a plain prompt's Approve, which stock reads as this call only", async () => {
		const onRespond = await mount(["Approve", "Deny"]);
		expect(rows().map(row => row.option)).toEqual(["Approve", "Deny"]);
		expect(rows()[0]?.text).toContain(translate("approval.approve"));
		await act(async () => {
			(document.body.querySelector('[data-choice="Approve"]') as HTMLButtonElement | null)?.click();
		});
		expect(onRespond).toHaveBeenCalledWith({ value: "Approve" });
	});
});
