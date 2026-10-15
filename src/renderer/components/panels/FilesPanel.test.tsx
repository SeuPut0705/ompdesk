/**
 * The files toolbar's count says what it counts ("2 files", "2000+ files"), and
 * an empty project shows only its empty state, not a bare "0". A folder link
 * (`filesRevealPath`) expands, selects and clears.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { FsTreeEntry } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { FilesPanel, gitDecorations, workspaceRelativePath } from "./FilesPanel";

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

let root: Root | null = null;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useUiStore.setState({ filesRevealPath: null });
});

async function mount(entries: FsTreeEntry[], truncated = false): Promise<HTMLElement> {
	Object.assign(window, {
		matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
		omp: { fs: { list: async () => ({ ok: true, entries, truncated }) } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<FilesPanel />
			</I18nProvider>,
		);
	});
	return container as unknown as HTMLElement;
}

const file = (path: string): FsTreeEntry => ({ kind: "file", name: path.split("/").at(-1) ?? path, path });

it("labels the file count and drops it for an empty project", async () => {
	const empty = await mount([]);
	expect(empty.querySelector("[data-file-count]")).toBeNull();
	await act(async () => root?.unmount());
	root = null;

	const two = await mount([file("plan.md"), { kind: "dir", name: "src", path: "src", children: [file("src/a.ts")] }]);
	expect(two.querySelector("[data-file-count]")?.textContent).toBe("2 files");
	await act(async () => root?.unmount());
	root = null;

	const capped = await mount([file("plan.md")], true);
	expect(capped.querySelector("[data-file-count]")?.textContent).toBe("1+ files");
});

it("maps a revealed folder onto the workspace tree", () => {
	expect(workspaceRelativePath("./src/lib/", "/repo")).toBe("src/lib");
	expect(workspaceRelativePath("/repo/src", "/repo/")).toBe("src");
	expect(workspaceRelativePath("/repo", "/repo")).toBe("");
	expect(workspaceRelativePath("/elsewhere/src", "/repo")).toBeNull();
	expect(workspaceRelativePath("/repository/src", "/repo")).toBeNull();
	expect(workspaceRelativePath("C:\\work\\app\\src\\", "C:\\work\\app")).toBe("src");
});

it("expands, selects and clears a revealed folder", async () => {
	useUiStore.setState({ filesRevealPath: "src/lib/" });
	const container = await mount([
		file("plan.md"),
		{
			kind: "dir",
			name: "src",
			path: "src",
			children: [{ kind: "dir", name: "lib", path: "src/lib", children: [file("src/lib/a.ts")] }],
		},
	]);
	await act(async () => {});
	const selected = container.querySelector('[role="treeitem"][aria-selected="true"]');
	expect(selected?.getAttribute("data-tree-id")).toBe("dir:src/lib");
	expect(selected?.getAttribute("tabindex")).toBe("0");
	expect(container.querySelector('[data-tree-id="file:src/lib/a.ts"]')).not.toBeNull();
	expect(useUiStore.getState().filesRevealPath).toBeNull();
});

it("marks git changes relative to the tab's folder, with dots on the folders above", () => {
	const changes = {
		isRepo: true,
		root: "/repo",
		base: "abc",
		truncated: false,
		files: [
			{ path: "app/src/a.ts", status: " M" },
			{ path: "app/new.ts", status: "??" },
			{ path: "app/b.ts", status: "A " },
			{ path: "app/c.ts", status: "UU" },
			{ path: "app/d.ts", status: "R " },
			{ path: "other/x.ts", status: " M" },
		],
	};
	const marks = gitDecorations(changes, "/repo/app");
	expect([...marks.files]).toEqual([
		["src/a.ts", "M"],
		["new.ts", "U"],
		["b.ts", "A"],
		["c.ts", "C"],
		["d.ts", "R"],
	]);
	expect([...marks.dirs]).toEqual(["src"]);
	expect(gitDecorations(changes, "C:\\elsewhere").files.size).toBe(0);
	expect(gitDecorations({ ...changes, root: "C:/repo" }, "C:\\repo\\app").files.get("src/a.ts")).toBe("M");
});
