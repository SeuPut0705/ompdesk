/**
 * PR Center detail (linkedom): the checks list follows GitHub's rollup row for row, including two checks that
 * share a name (one workflow's `check` job beside another's).
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand, RpcPrDetail } from "../../../../shared/rpc-types";
import { I18nProvider, setLanguageOverride } from "../../../lib/i18n";
import { usePrCenterStore } from "../../../stores/pr-center";
import { PrDetail } from "./PrDetail";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

// react-dom must load after linkedom's globals above, so this import cannot be static.
const { createRoot } = await import("react-dom/client");

interface TestElement {
	textContent: string | null;
	remove: () => void;
}

const DETAIL: RpcPrDetail = {
	number: 7,
	title: "Add a thing",
	url: "https://github.com/o/r/pull/7",
	isDraft: false,
	authorLogin: "me",
	body: "",
	baseRefName: "main",
	headRefName: "feat/thing",
	mergeStateStatus: "CLEAN",
	state: "OPEN",
	additions: 1,
	deletions: 0,
	reviewDecision: null,
	files: [],
	checks: [],
};

let root: Root;
let container: TestElement;

function install(): void {
	(window as unknown as { omp: unknown }).omp = {
		rpc: {
			command: vi.fn(async (cmd: RpcCommand) => ({
				type: "response",
				command: cmd.type,
				success: true,
				data: cmd.type === "pr_comments" ? { entries: [] } : {},
			})),
		},
	};
}

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<PrDetail onCreateOpen={() => {}} />
			</I18nProvider>,
		);
	});
}

const checkRows = () =>
	(Array.from(document.querySelectorAll("[data-pr-check]")) as unknown as TestElement[]).map(row => row.textContent);

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	usePrCenterStore.getState().reset();
	setLanguageOverride(null);
});

describe("PR detail checks", () => {
	it("lists each check of the rollup as it stands when two share a name", async () => {
		install();
		usePrCenterStore.setState({
			selected: 7,
			detail: {
				...DETAIL,
				checks: [
					{ name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
					{ name: "build", status: "IN_PROGRESS", conclusion: null },
					{ name: "check", status: "IN_PROGRESS", conclusion: null },
				],
			},
		});
		await mount();
		expect(checkRows()).toEqual(["checkpassed", "buildrunning", "checkrunning"]);

		// The next read: the first workflow's run is gone from the rollup, the rest moved on.
		await act(async () =>
			usePrCenterStore.setState({
				detail: {
					...DETAIL,
					checks: [
						{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
						{ name: "check", status: "COMPLETED", conclusion: "FAILURE" },
					],
				},
			}),
		);
		expect(checkRows()).toEqual(["buildpassed", "checkfailed"]);
	});

	it("names each state in the UI's language, and one GitHub adds later as GitHub spells it", async () => {
		install();
		setLanguageOverride("ko");
		usePrCenterStore.setState({
			selected: 7,
			detail: {
				...DETAIL,
				checks: [
					{ name: "a", status: "COMPLETED", conclusion: "TIMED_OUT" },
					{ name: "b", status: "IN_PROGRESS", conclusion: null },
					{ name: "c", status: "PENDING", conclusion: null },
					{ name: "d", status: "COMPLETED", conclusion: "BRAND_NEW_STATE" },
				],
			},
		});
		await mount();
		expect(checkRows()).toEqual(["a시간 초과", "b진행 중", "c보류 중", "dbrand new state"]);
	});
});
