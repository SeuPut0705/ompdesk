import { posix, win32 } from "node:path";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../../stores/tools";
import { useUiStore } from "../../../stores/ui";
import { workFilePathKey } from "../../tools/edit-args";
import { WorkOutcome } from "./WorkOutcome";
import { workOutcomes } from "./work-view";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLElement | undefined;
let sequence = 0;
function entry(toolName: string, args: Record<string, unknown>, details: Record<string, unknown> = {}): ToolEntry {
	return {
		toolName,
		args,
		status: "done",
		streamingArgs: "",
		result: { content: [{ type: "text", text: "Success" }], details },
		isError: false,
		startTime: ++sequence,
		endTime: sequence + 1,
	};
}
function write(path = "tools/_menu_shot.gd") {
	// Stock write returns resolvedPath, but no diff or creation flag.
	return entry("write", { path, content: "alpha\nbeta\ngamma\n" }, { resolvedPath: `/project/${path}` });
}
async function mount(entries: ToolEntry[]) {
	const ids = entries.map((_, index) => `call-${index}`);
	useToolsStore.setState(toolEntriesState(entries.map((item, index) => [ids[index], item])));
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<WorkOutcome toolCallIds={ids} />
			</I18nProvider>,
		);
	});
	return container;
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	useToolsStore.getState().reset();
	useSubagentsStore.getState().reset();
	useUiStore.getState().setTranscriptDetail("compact");
	useSessionStore.getState().reset();
	sequence = 0;
});

describe("work outcome evidence", () => {
	it.each(["rm tools/_menu_shot.gd", "rm -f tools/_menu_shot.gd", "git rm -f -- tools/_menu_shot.gd"])(
		"marks a plain write deleted when a later successful command removes it: %s",
		command => {
			expect(workOutcomes([write(), entry("bash", { command })]).files).toEqual([
				{ path: "tools/_menu_shot.gd", deleted: true },
			]);
		},
	);
	it.each(["rm tools/_menu_shot.gd", "rm -f tools/_menu_shot.gd", "git rm -- tools/_menu_shot.gd"])(
		"drops only certainly created files after %s",
		command => {
			const create = entry("edit", {}, { path: "tools/_menu_shot.gd", op: "create", diff: "+alpha" });
			expect(workOutcomes([create, entry("bash", { command })]).files).toEqual([]);
		},
	);
	// Installed stock has no shipped tokenizer tests. Mirror shell-tokenize.ts's
	// documented quoted-word cases and its expansion/operator rejection classes.
	it.each(["rm 'notes with spaces.txt'", 'rm "notes with spaces.txt"'])(
		"recognizes stock documented literal quoted words: %s",
		command => {
			expect(workOutcomes([write("notes with spaces.txt"), entry("bash", { command })]).files).toEqual([
				{ path: "notes with spaces.txt", deleted: true },
			]);
		},
	);
	it.each([
		"rm tools/_menu_shot.gd.bak",
		"echo rm tools/_menu_shot.gd",
		"rm tools/*.gd",
		"git rm --cached tools/_menu_shot.gd",
		"false && rm tools/_menu_shot.gd",
		'rm "$FILE"',
		"rm $(printf tools/_menu_shot.gd)",
		"rm `printf tools/_menu_shot.gd`",
		"(rm tools/_menu_shot.gd)",
		"rm tools/_menu_shot.gd # comment",
		"rm tools/_menu_shot.gd > output.txt",
		"FILE=tools/_menu_shot.gd rm $FILE",
		"sh -c 'rm tools/_menu_shot.gd'",
		"rm tools/_menu_shot.gd; true",
		"rm tools/_menu_shot.gd | cat",
		"rm tools/_menu_shot.gd || true",
	])("does not guess a deletion from %s", command => {
		expect(workOutcomes([write(), entry("bash", { command })]).files).toEqual([
			{ path: "tools/_menu_shot.gd", added: 3, removed: 0 },
		]);
	});
	it("keeps writes when removal failed, was interrupted, ran elsewhere, or happened first", () => {
		const failed = { ...entry("bash", { command: "rm tools/_menu_shot.gd" }, { exitCode: 1 }), isError: true };
		expect(workOutcomes([write(), failed]).files).toHaveLength(1);
		const aborted = { ...entry("bash", { command: "rm tools/_menu_shot.gd" }), status: "aborted" as const };
		expect(workOutcomes([write(), aborted]).files).toHaveLength(1);
		expect(
			workOutcomes([write(), entry("bash", { command: "rm tools/_menu_shot.gd", cwd: "/elsewhere" })]).files,
		).toHaveLength(1);
		expect(workOutcomes([entry("bash", { command: "rm tools/_menu_shot.gd" }), write()]).files).toHaveLength(1);
	});
	it("does not let another agent's command erase a file with the same relative path", () => {
		expect(
			workOutcomes([write(), { entry: entry("bash", { command: "rm tools/_menu_shot.gd" }), agentName: "other" }])
				.files,
		).toHaveLength(1);
	});
	it("marks child explicit aborts interrupted but never applies the parent stop to child errors", () => {
		const aborted = { ...entry("bash", { command: "child abort" }), status: "aborted" as const };
		const failed = { ...entry("bash", { command: "child fail" }), status: "error" as const, isError: true };
		const outcome = workOutcomes(
			[
				{ entry: aborted, agentName: "child" },
				{ entry: failed, agentName: "child" },
			],
			2,
		);
		expect(outcome.commands[0]).toMatchObject({ unknown: true, interrupted: true });
		expect(outcome.commands[1]).toMatchObject({ failed: true });
		expect(outcome.commands[1].interrupted).toBeUndefined();
	});
	it("marks a plain write deleted but drops proven creates for stock single-file and multi-file deletes", () => {
		for (const details of [
			{ path: "tools/_menu_shot.gd", op: "delete", diff: "@@ -1,3 +0,0 @@\n-alpha\n-beta\n-gamma" },
			{ perFileResults: [{ path: "tools/_menu_shot.gd", op: "delete", diff: "-alpha\n-beta\n-gamma" }] },
		]) {
			expect(workOutcomes([write(), entry("edit", {}, details)]).files).toEqual([
				{ path: "tools/_menu_shot.gd", deleted: true },
			]);
			const create = entry("apply_patch", {}, { path: "tools/_menu_shot.gd", op: "create", diff: "+alpha" });
			expect(workOutcomes([create, entry("edit", {}, details)]).files).toEqual([]);
		}
	});
	it("nets stock replacement diffs after a write instead of counting newly written lines twice", () => {
		const edit = entry(
			"edit",
			{ path: "notes.txt" },
			{ path: "notes.txt", op: "update", diff: "@@ -1,3 +1,3 @@\n alpha\n-beta\n+updated\n gamma" },
		);
		expect(workOutcomes([write("notes.txt"), edit]).files).toEqual([{ path: "notes.txt", added: 3, removed: 0 }]);
	});
	it.each([
		["/project", "notes.txt", "/project/notes.txt"],
		["/project", "./folder/../notes.txt", "/project/./notes.txt"],
		["C:\\project", "notes.txt", "C:\\project\\notes.txt"],
	])("pairs relative write and resolved edit paths under %s", (cwd, path, resolvedPath) => {
		const created = entry("write", { path, content: "alpha\n" }, { resolvedPath });
		const edited = entry("edit", { path }, { path: resolvedPath, op: "update", diff: "-alpha\n+beta" });
		expect(workFilePathKey(path, cwd)).toBe(workFilePathKey(resolvedPath, cwd));
		expect(workOutcomes([created, edited], undefined, cwd).files).toEqual([{ path, added: 1, removed: 0 }]);
	});
	it("does not merge equal basenames in different directories", () => {
		expect(workFilePathKey("notes.txt", "/project")).not.toBe(workFilePathKey("/elsewhere/notes.txt", "/project"));
	});
	it("renders the real relative-write plus absolute-edit shape as one net changed file", async () => {
		useSessionStore.setState({ cwd: "/project" });
		const created = entry("write", { path: "notes.txt", content: "alpha\n" }, { resolvedPath: "/project/notes.txt" });
		const edited = entry(
			"edit",
			{ path: "notes.txt" },
			{ path: "/project/notes.txt", diff: "-alpha\n+beta", op: "update" },
		);
		const view = await mount([created, edited]);
		// Counts live once, in the card's head; the outcome lists the file, project-relative.
		expect(view.querySelector("summary")?.textContent).toBe("Outcome");
		expect(view.querySelectorAll('[data-kind="file"]')).toHaveLength(1);
		expect(view.querySelector('[data-kind="file"]')?.textContent).toBe("notes.txt +1 −0");
	});
	it.each([
		["/project/src", "../notes.txt", false],
		["/project/src", "/project/./notes.txt", false],
		["C:\\project\\src", "..\\notes.txt", true],
		["C:\\project\\src", "\\notes.txt", true],
		["\\\\server\\share\\src", "..\\notes.txt", true],
	])("pins the renderer lexical key to node:path for %s + %s", (cwd, path, windows) => {
		const expected = (windows ? win32 : posix).resolve(cwd, path).replace(/\\/g, "/");
		expect(workFilePathKey(path, cwd)).toBe(expected);
	});
	it("nets stock create and subsequent per-file diffs", () => {
		const create = entry("edit", {}, { path: "notes.txt", op: "create", diff: "@@ -0,0 +1,2 @@\n+alpha\n+beta" });
		const update = entry(
			"edit",
			{},
			{
				perFileResults: [{ path: "notes.txt", op: "update", diff: "@@ -1,2 +1,3 @@\n-alpha\n+new\n+extra\n beta" }],
			},
		);
		expect(workOutcomes([create, update]).files).toEqual([{ path: "notes.txt", added: 3, removed: 0 }]);
	});
	it("keeps normal edit churn and falls back to nonnegative sums for incomplete evidence", () => {
		const edit = () => entry("edit", { path: "notes.txt" }, { diff: "-alpha\n+new" });
		expect(workOutcomes([edit(), edit()]).files).toEqual([{ path: "notes.txt", added: 2, removed: 2 }]);
		expect(
			workOutcomes([write("notes.txt"), entry("edit", { path: "notes.txt" }, { diff: "-a\n-b\n-c\n-d" })]).files,
		).toEqual([{ path: "notes.txt", added: 3, removed: 4 }]);
	});
	it("renders a removed plain write as deleted, not as added lines", async () => {
		const view = await mount([write(), entry("bash", { command: "rm -f tools/_menu_shot.gd" })]);
		expect(view.querySelector('[data-kind="file"]')?.textContent).toContain("Deleted");
		expect(view.querySelector("summary")?.textContent).not.toContain("+3");
		expect(view.querySelector('[data-kind="command"]')).not.toBeNull();
	});
	it("renders net line counts and preserves full path text on hover", async () => {
		const path = "a/very/long/path/notes.txt";
		const view = await mount([write(path), entry("edit", { path }, { diff: "-beta\n+updated" })]);
		expect(view.querySelector('[data-kind="file"]')?.textContent).toContain("+3 −0");
		expect(view.querySelector('[data-kind="file"] [title]')?.getAttribute("title")).toBe(path);
	});
	it("caps images and expands the remaining accessible zoom thumbnails on click", async () => {
		let imageExtractions = 0;
		const reads = Array.from({ length: 5 }, (_, index) => ({
			...entry("read", { path: `shots/image-${index}.png` }),
			result: {
				get content() {
					imageExtractions++;
					return [{ type: "image", mimeType: "image/png", data: `image${index}` }];
				},
			},
		}));
		const view = await mount(reads);
		const initialExtractions = imageExtractions;
		expect(view.querySelectorAll("[data-zoomable-image]")).toHaveLength(4);
		const more = view.querySelector(".omp-work-images > button");
		expect(more?.textContent).toBe("+1 more");
		await act(async () => more?.dispatchEvent(new Event("click", { bubbles: true })));
		expect(view.querySelectorAll("[data-zoomable-image]")).toHaveLength(5);
		expect(more?.getAttribute("aria-expanded")).toBe("true");
		expect(imageExtractions).toBe(initialExtractions);
		// Named by the file, never a raw path as alt text.
		expect(view.querySelector("img")?.getAttribute("alt")).toBe("image-0.png");
		expect(view.querySelector("details")).toBeNull();
	});
	it("draws a stored read image and shows one whose bytes are gone as its file, never a broken image", async () => {
		// Stock's read of a PNG as a subagent journal persists it: the bytes live in the blob store.
		const read = (path: string, data: string): ToolEntry => ({
			...entry("read", { path }),
			result: {
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data, mimeType: "image/png" },
				],
				details: { fileSize: 120207, meta: { source: { type: "path", value: path } }, mediaPath: path },
			},
		});
		const view = await mount([
			read("/tmp/ReloadTruth-real/scenarios/ko-group-1.png", "iVBORw0KGgo="),
			read("/tmp/final2/real/scenarios/ko-group-1.png", `blob:sha256:${"0".repeat(64)}`),
		]);
		const images = [...view.querySelectorAll(".omp-work-images img")];
		expect(images.map(image => image.getAttribute("src"))).toEqual(["data:image/png;base64,iVBORw0KGgo="]);
		for (const image of view.querySelectorAll("img")) {
			expect(image.getAttribute("src")).not.toContain("blob:sha256:");
			expect(image.getAttribute("alt")).not.toContain("/");
		}
		const chip = view.querySelector(".omp-work-images [data-image-unavailable]");
		expect(chip?.textContent).toContain("ko-group-1.png");
		expect(chip?.querySelector("button")?.getAttribute("title")).toBe("/tmp/final2/real/scenarios/ko-group-1.png");
	});
});
