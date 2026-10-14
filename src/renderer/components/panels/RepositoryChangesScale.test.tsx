/**
 * RepositoryChanges on a big change set (linkedom, same harness as
 * RepositoryChanges.test.tsx): the file list and an open diff mount only the
 * rows near the viewport. Mounting every row of 1,000 files or a 5,000-line
 * diff made one 65–180 ms frame when the panel or the diff opened.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcGitChanges } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { RepositoryChanges } from "./RepositoryChanges";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

// After the linkedom globals: react-dom reads `document` and `window` when it loads.
const { createRoot } = await import("react-dom/client");

const FILES = 1000;
const DIFF_LINES = 5000;

let root: Root | undefined;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

afterEach(async () => {
	if (root) {
		const mounted = root;
		await act(async () => mounted.unmount());
	}
	root = undefined;
	document.body.innerHTML = "";
});

describe("RepositoryChanges at scale", () => {
	it("mounts a bounded number of list rows and diff lines", async () => {
		const data: RpcGitChanges = {
			isRepo: true,
			root: "/work",
			base: "main",
			files: Array.from({ length: FILES }, (_, index) => ({
				path: `src/f${index}.ts`,
				status: "M",
				added: 1,
				removed: 1,
			})),
			truncated: false,
		};
		const body = Array.from({ length: DIFF_LINES }, (_, index) => `+const value${index} = ${index};`).join("\n");
		const getGitDiff = vi.fn(async (path: string) => ({
			success: true,
			data: {
				path,
				kind: "text",
				truncated: false,
				diff: `--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${DIFF_LINES} @@\n${body}\n`,
			},
		}));
		Object.assign(window, {
			omp: { rpc: { getGitChanges: vi.fn(async () => ({ success: true, data })), getGitDiff } },
		});
		const container = document.createElement("div");
		document.body.appendChild(container);
		const mounted = createRoot(container as unknown as Element);
		root = mounted;
		await act(async () => {
			mounted.render(
				<I18nProvider>
					<RepositoryChanges />
				</I18nProvider>,
			);
		});
		await flush();
		await flush();

		const rows = document.querySelectorAll(".omp-changes-list button[title]");
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.length).toBeLessThan(100);

		const first = document.querySelector('button[title="src/f0.ts"]');
		if (!first)
			throw new Error(`first file row not mounted: ${[...rows].map(row => row.getAttribute("title")).join(",")}`);
		const click = new Event("click", { bubbles: true, cancelable: true });
		Object.defineProperty(click, "eventPhase", { value: 0, writable: true, configurable: true });
		await act(async () => {
			first.dispatchEvent(click);
		});
		await flush();
		await flush();

		expect(getGitDiff).toHaveBeenCalledWith("src/f0.ts");
		const diff = document.querySelector(".omp-pane-diff");
		expect(diff?.getAttribute("style")).toContain("--omp-gutter-digits:4");
		const lines = document.querySelectorAll(".omp-pane-diff [data-index]");
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.length).toBeLessThan(200);
		expect(document.body.textContent).toContain("const value0 = 0;");
	});
});
